/**
 * Pure, defensive: Mintsoft despatch payload → Wix fulfilment (SPEC §4.2, §6.3). No I/O.
 *
 * VERIFY: the exact despatch-webhook payload shape. SPEC says it's the same JSON as
 * GET /api/Order/{id}. Field lookups below are case-insensitive and try known
 * alternates, and `keys` reports what actually arrived so names can be corrected.
 *
 * Agreed rules:
 *   - No tracking number → still fulfil (without tracking).
 *   - Split / partial despatch → fulfil only the despatched quantities, matched to
 *     Wix line items by SKU, capped at what's still unfulfilled.
 */
import type { WixCreateFulfillmentRequest, WixFulfillment, WixLineItem, WixOrder } from "../adapters/wix/types";
import type { ErrorCode } from "../errorCodes";
import { classifyLine } from "./validation";

export interface DespatchItem {
  sku: string;
  quantity: number;
}

export interface DespatchInfo {
  mintsoftOrderId: number | null;
  mintsoftClientId: number | null;
  externalOrderReference: string | null;
  orderNumber: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  /** null = payload had no item list (fetch GET /api/Order/{id}/Items). */
  items: DespatchItem[] | null;
  /** Top-level keys that arrived (names only, never values) — for diagnosing renamed fields. */
  keys: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Case-insensitive lookup of the first present key. */
function pick(o: Obj, ...names: string[]): unknown {
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function parseDespatchItems(raw: unknown): DespatchItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DespatchItem[] = [];
  for (const it of raw) {
    if (!isObj(it)) continue;
    const sku = str(pick(it, "SKU", "Sku", "ProductSKU"));
    const qty = int(pick(it, "QuantityDespatched", "Quantity", "Qty"));
    if (sku && qty) out.push({ sku, quantity: qty });
  }
  return out;
}

export function parseDespatchPayload(payload: unknown): DespatchInfo {
  let o: unknown = Array.isArray(payload) ? payload[0] : payload;
  // Tolerate a wrapper like { Order: { ... } }.
  if (isObj(o) && isObj(pick(o, "Order")) && pick(o, "ID", "OrderId") === undefined) o = pick(o, "Order");
  if (!isObj(o)) {
    return { mintsoftOrderId: null, mintsoftClientId: null, externalOrderReference: null, orderNumber: null, trackingNumber: null, trackingUrl: null, courierName: null, items: null, keys: [] };
  }
  const courier = pick(o, "CourierService");
  const rawItems = pick(o, "OrderItems", "Items");
  return {
    mintsoftOrderId: int(pick(o, "ID", "OrderId", "Id")),
    mintsoftClientId: int(pick(o, "ClientId")),
    externalOrderReference: str(pick(o, "ExternalOrderReference", "ExternalReference")),
    orderNumber: str(pick(o, "OrderNumber")),
    trackingNumber: str(pick(o, "TrackingNumber", "TrackingNo", "TrackingCode")),
    trackingUrl: str(pick(o, "TrackingURL", "TrackingUrl", "TrackingLink")),
    courierName: str((isObj(courier) ? pick(courier, "Name") : undefined) ?? pick(o, "CourierServiceName", "CourierName")),
    items: Array.isArray(rawItems) ? parseDespatchItems(rawItems) : null,
    keys: Object.keys(o).sort(),
  };
}

export type FulfilmentPlan =
  | {
      kind: "create";
      request: WixCreateFulfillmentRequest;
      /** True when, after this fulfilment, every shippable line is fully fulfilled. */
      completesOrder: boolean;
      /** Despatched SKUs not on the Wix order, or quantities beyond what was unfulfilled. */
      unmatched: DespatchItem[];
    }
  | { kind: "nothing_remaining" }
  | { kind: "error"; code: ErrorCode; message: string };

export interface PlanInput {
  wixOrder: WixOrder;
  existingFulfilments: readonly WixFulfillment[];
  despatched: readonly DespatchItem[];
  tracking: { number: string; url: string | null; provider: string } | null;
}

/** Remaining unfulfilled quantity per shippable Wix line item id. */
export function remainingByLine(order: WixOrder, existing: readonly WixFulfillment[]): Map<string, number> {
  const fulfilled = new Map<string, number>();
  for (const f of existing) {
    if (f.completed === false) continue;
    for (const li of f.lineItems ?? []) fulfilled.set(li.id, (fulfilled.get(li.id) ?? 0) + (li.quantity ?? 0));
  }
  const remaining = new Map<string, number>();
  for (const line of shippableLines(order)) {
    remaining.set(line.id, Math.max(0, (line.quantity ?? 0) - (fulfilled.get(line.id) ?? 0)));
  }
  return remaining;
}

function shippableLines(order: WixOrder): WixLineItem[] {
  return (order.lineItems ?? []).filter((l) => classifyLine(l) !== "skip");
}

export function planFulfilment(input: PlanInput): FulfilmentPlan {
  const { wixOrder } = input;
  if (wixOrder.status === "CANCELED") {
    return { kind: "error", code: "order_cancelled", message: `Wix order ${wixOrder.number} is cancelled in Wix; not fulfilling` };
  }
  const remaining = remainingByLine(wixOrder, input.existingFulfilments);
  const totalRemaining = [...remaining.values()].reduce((a, b) => a + b, 0);
  if (totalRemaining === 0) return { kind: "nothing_remaining" };

  const lines = shippableLines(wixOrder);
  const allocation = new Map<string, number>();
  const unmatched: DespatchItem[] = [];

  for (const item of input.despatched) {
    let left = item.quantity;
    for (const line of lines.filter((l) => l.physicalProperties?.sku?.trim() === item.sku)) {
      const free = (remaining.get(line.id) ?? 0) - (allocation.get(line.id) ?? 0);
      const take = Math.min(free, left);
      if (take > 0) {
        allocation.set(line.id, (allocation.get(line.id) ?? 0) + take);
        left -= take;
      }
      if (left === 0) break;
    }
    if (left > 0) unmatched.push({ sku: item.sku, quantity: left });
  }

  if (allocation.size === 0) {
    const skus = input.despatched.map((d) => `${d.sku} × ${d.quantity}`).join(", ") || "(none)";
    return {
      kind: "error",
      code: "despatch_mismatch",
      message: `Wix order ${wixOrder.number}: despatched items ${skus} don't match any unfulfilled Wix line`,
    };
  }

  const completesOrder = [...remaining.entries()].every(([id, r]) => r - (allocation.get(id) ?? 0) === 0);
  const request: WixCreateFulfillmentRequest = {
    fulfillment: { lineItems: [...allocation.entries()].map(([id, quantity]) => ({ id, quantity })) },
  };
  if (input.tracking) {
    request.fulfillment.trackingInfo = {
      trackingNumber: input.tracking.number,
      shippingProvider: input.tracking.provider,
      ...(isWebUrl(input.tracking.url) ? { trackingLink: input.tracking.url! } : {}),
    };
  } else {
    // Agreed: fulfil untracked despatches anyway. VERIFY: Wix's schema marks trackingInfo /
    // customInfo as one-of; customInfo is sent so the request has one of them.
    request.fulfillment.customInfo = { fieldsData: { tracking: "Untracked" } };
  }
  return { kind: "create", request, completesOrder, unmatched };
}

function isWebUrl(u: string | null): boolean {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}
