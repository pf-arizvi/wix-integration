/**
 * F2: Mintsoft despatch → Wix fulfilment with tracking (SPEC §6.2, §6.3).
 * Called by the despatch webhook (and, in Phase 3, by reconcile).
 *
 * Per despatched Mintsoft order (a split part has its own Mintsoft order ID):
 *   parse payload → guard ClientId → find our order_map row → already done? →
 *   despatched items (payload, else GET /api/Order/{id}/Items) → read the Wix order and
 *   its fulfilments → fulfil only what this despatch shipped (capped at what's unfulfilled)
 *   → record: 'fulfilled' when the whole order is done, 'despatched' when partial.
 *
 * Idempotent: the fulfilments table (one row per Mintsoft order), the remaining-quantity
 * cap, and Wix's 409 on a duplicate tracking number.
 * Writes to Wix only (never Mintsoft). Wix may email the buyer a shipping notification.
 */
import type { WixOrder } from "../adapters/wix/types";
import { getCarrierName } from "../db/carrierNames";
import type { ClientRecord } from "../db/clients";
import { listCourierRules } from "../db/courierMap";
import { recordError } from "../db/errors";
import { getFulfilment, saveFulfilmentOutcome } from "../db/fulfilments";
import { getOrderMapByMintsoftId, getOrderMapByWixId, getOrderMapByWixNumber, type OrderMapRecord } from "../db/orderMap";
import type { ErrorCode } from "../errorCodes";
import { HttpError } from "../lib/http";
import { log } from "../lib/log";
import { normaliseShippingTitle } from "../mapping/courierMap";
import { type DespatchInfo, parseDespatchItems, parseDespatchPayload, planFulfilment } from "../mapping/trackingMapper";
import type { FlowDeps } from "./ports";

export type DespatchOutcome =
  | { outcome: "fulfilled" | "partially_fulfilled"; wixOrderNumber: string; mintsoftOrderId: number; tracked: boolean; note?: string }
  | { outcome: "already_done"; wixOrderNumber: string; mintsoftOrderId: number | null }
  | { outcome: "error"; code: ErrorCode; message: string };

export async function handleDespatch(deps: FlowDeps, client: ClientRecord, payload: unknown): Promise<DespatchOutcome> {
  const d = parseDespatchPayload(payload);
  log.info("pushTracking.received", { client: client.slug, mintsoftOrderId: d.mintsoftOrderId, keys: d.keys });

  const fail = async (code: ErrorCode, message: string, ref: string | null): Promise<DespatchOutcome> => {
    await recordError(deps.db, { clientId: client.id, flow: "pushTracking", ref, code, message });
    log.warn("pushTracking.error", { client: client.slug, code, mintsoftOrderId: d.mintsoftOrderId });
    return { outcome: "error", code, message };
  };

  // Guardrail: a despatch for another Mintsoft client must never touch this client's Wix store.
  if (d.mintsoftClientId != null && d.mintsoftClientId !== client.mintsoftClientId) {
    return fail(
      "mintsoft_client_mismatch",
      `Despatch for Mintsoft order ${d.mintsoftOrderId ?? "?"} has ClientId ${d.mintsoftClientId} but arrived on client ${client.slug}'s webhook (ClientId ${client.mintsoftClientId}). Ignored.`,
      d.orderNumber,
    );
  }

  const row = await findOrderRow(deps, client, d);
  if (!row) {
    return fail(
      "order_not_found",
      `Despatch for Mintsoft order ${d.mintsoftOrderId ?? "?"} (OrderNumber ${d.orderNumber ?? "?"}) doesn't match any imported Wix order. Payload keys: ${d.keys.join(", ") || "(none)"}`,
      d.orderNumber,
    );
  }
  const mintsoftOrderId = d.mintsoftOrderId ?? row.mintsoftOrderId;
  if (mintsoftOrderId == null) {
    return fail("despatch_payload_invalid", `Despatch for Wix order ${row.wixOrderNumber} has no Mintsoft order ID`, row.wixOrderNumber);
  }

  // Idempotency.
  const done = await getFulfilment(deps.db, client.id, mintsoftOrderId);
  if (done?.status === "created" || row.status === "fulfilled") {
    return { outcome: "already_done", wixOrderNumber: row.wixOrderNumber, mintsoftOrderId };
  }

  const base = { clientId: client.id, wixOrderId: row.wixOrderId, mintsoftOrderId, trackingNumber: d.trackingNumber };
  const failFulfil = async (code: ErrorCode, message: string): Promise<DespatchOutcome> => {
    await saveFulfilmentOutcome(deps.db, {
      ...base,
      wixFulfillmentId: null,
      status: "failed",
      lastError: message,
      orderStatus: "fulfil_failed",
      error: { clientId: client.id, flow: "pushTracking", ref: row.wixOrderNumber, code, message },
    });
    log.warn("pushTracking.fulfil_failed", { client: client.slug, order: row.wixOrderNumber, code });
    return { outcome: "error", code, message };
  };

  try {
    // What did this despatch actually ship?
    let items = d.items;
    if (!items || items.length === 0) items = parseDespatchItems(await deps.wms.getOrderItems(mintsoftOrderId));
    if (items.length === 0) {
      return failFulfil("despatch_payload_invalid", `Despatch for Wix order ${row.wixOrderNumber}: no items found for Mintsoft order ${mintsoftOrderId}`);
    }

    const target = await deps.fulfilmentTargetFor(client);
    const wixOrder = await target.getOrder(row.wixOrderId);
    const existing = await target.listFulfilments(row.wixOrderId);
    // Carrier shown in Wix: our carrier_names mapping for the service actually used (Mintsoft sends
    // CourierServiceId but CourierServiceName is null) → payload name → courier map → client default.
    const provider =
      (d.courierServiceId != null ? await getCarrierName(deps.db, d.courierServiceId) : null) ??
      d.courierName ??
      (await carrierFromCourierMap(deps, client, wixOrder)) ??
      client.defaultCarrierName ??
      "Courier";

    const plan = planFulfilment({
      wixOrder,
      existingFulfilments: existing,
      despatched: items,
      tracking: d.trackingNumber ? { number: d.trackingNumber, url: d.trackingUrl, provider } : null,
    });

    if (plan.kind === "error") return failFulfil(plan.code, plan.message);
    if (plan.kind === "nothing_remaining") {
      await saveFulfilmentOutcome(deps.db, { ...base, wixFulfillmentId: null, status: "created", lastError: null, orderStatus: "fulfilled" });
      return { outcome: "already_done", wixOrderNumber: row.wixOrderNumber, mintsoftOrderId };
    }

    const res = await target.createFulfilment(row.wixOrderId, plan.request);
    const note = plan.unmatched.length
      ? `Not on the Wix order or already fulfilled: ${plan.unmatched.map((u) => `${u.sku} × ${u.quantity}`).join(", ")}`
      : undefined;
    await saveFulfilmentOutcome(deps.db, {
      ...base,
      wixFulfillmentId: res.status === "created" ? res.fulfillmentId : null,
      status: "created",
      lastError: null,
      orderStatus: plan.completesOrder ? "fulfilled" : "despatched",
      ...(note
        ? { error: { clientId: client.id, flow: "pushTracking" as const, ref: row.wixOrderNumber, code: "despatch_mismatch" as const, message: `Wix order ${row.wixOrderNumber}: ${note}` } }
        : {}),
    });
    log.info("pushTracking.fulfilled", {
      client: client.slug,
      order: row.wixOrderNumber,
      mintsoftOrderId,
      complete: plan.completesOrder,
      tracked: !!d.trackingNumber,
      duplicate: res.status === "already_exists",
    });
    return {
      outcome: plan.completesOrder ? "fulfilled" : "partially_fulfilled",
      wixOrderNumber: row.wixOrderNumber,
      mintsoftOrderId,
      tracked: !!d.trackingNumber,
      ...(note ? { note } : {}),
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return failFulfil(err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", `Wix order ${row.wixOrderNumber}: ${err.message}`);
    }
    throw err;
  }
}

/** ExternalOrderReference (Wix order id) → Mintsoft order id → OrderNumber (minus the client prefix). */
export async function findOrderRow(deps: FlowDeps, client: ClientRecord, d: DespatchInfo): Promise<OrderMapRecord | null> {
  if (d.externalOrderReference) {
    const r = await getOrderMapByWixId(deps.db, client.id, d.externalOrderReference);
    if (r) return r;
  }
  if (d.mintsoftOrderId != null) {
    const r = await getOrderMapByMintsoftId(deps.db, client.id, d.mintsoftOrderId);
    if (r) return r;
  }
  if (d.orderNumber) {
    const prefix = client.orderNumberPrefix;
    const num = prefix && d.orderNumber.startsWith(prefix) ? d.orderNumber.slice(prefix.length) : d.orderNumber;
    return getOrderMapByWixNumber(deps.db, client.id, num);
  }
  return null;
}

async function carrierFromCourierMap(deps: FlowDeps, client: ClientRecord, order: WixOrder): Promise<string | null> {
  const title = order.shippingInfo?.title;
  if (!title) return null;
  const rules = await listCourierRules(deps.db, client.id);
  return rules.find((r) => normaliseShippingTitle(r.wixShippingTitle) === normaliseShippingTitle(title))?.carrierDisplayName ?? null;
}

/**
 * SPEC §6.4: a Mintsoft cancellation is logged for manual follow-up. Nothing is changed in Wix.
 */
export async function handleCancel(deps: FlowDeps, client: ClientRecord, payload: unknown): Promise<{ recorded: true }> {
  const d = parseDespatchPayload(payload);
  const message =
    `Mintsoft order ${d.mintsoftOrderId ?? "?"} (OrderNumber ${d.orderNumber ?? "?"}) was cancelled in Mintsoft. ` +
    `The Wix order has not been changed; follow up manually.`;
  await recordError(deps.db, { clientId: client.id, flow: "pushTracking", ref: d.orderNumber, code: "mintsoft_cancelled", message });
  log.warn("pushTracking.cancelled", { client: client.slug, mintsoftOrderId: d.mintsoftOrderId, keys: d.keys });
  return { recorded: true };
}
