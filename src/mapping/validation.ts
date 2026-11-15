/**
 * Pure order validation (SPEC §4.1, §6.1, §6.4). No I/O.
 * Any failing line holds the WHOLE order — never partially import.
 */
import type { WixAddress, WixLineItem, WixOrder } from "../adapters/wix/types";
import type { ErrorCode } from "../errorCodes";
import { deliveryAddress, deliveryContact } from "./orderMapper";

export type ValidationResult =
  | { kind: "ok"; lines: WixLineItem[] }
  /** Not ours to import (yet). Not recorded in order_map, so it is re-evaluated later. */
  | { kind: "skip"; reason: "cancelled" | "not_paid" | "already_fulfilled" }
  /** Nothing to ship (digital / gift card / service only). Recorded as skipped_non_physical. */
  | { kind: "non_physical" }
  | { kind: "hold"; code: ErrorCode; message: string };

const NON_PHYSICAL_PRESETS = new Set(["DIGITAL", "GIFT_CARD", "SERVICE"]);

type LineClass = "ship" | "skip" | "ambiguous";

/**
 * SPEC: skip lines where shippable === false or itemType.preset !== "PHYSICAL".
 * Safety addition: a line Wix marks shippable but with an unrecognised/custom item
 * type is "ambiguous" — we hold the order rather than silently drop a physical item.
 */
export function classifyLine(line: WixLineItem): LineClass {
  if (line.physicalProperties?.shippable === false) return "skip";
  const preset = line.itemType?.preset;
  if (preset === "PHYSICAL") return "ship";
  if (preset && NON_PHYSICAL_PRESETS.has(preset)) return "skip";
  return line.physicalProperties?.shippable === true ? "ambiguous" : "skip";
}

export function validateWixOrder(order: WixOrder): ValidationResult {
  const ref = `Order ${order.number}`;

  // Defensive: the search already filters these, but never trust a single layer.
  if (order.status === "CANCELED") return { kind: "skip", reason: "cancelled" };
  if (order.paymentStatus !== "PAID") return { kind: "skip", reason: "not_paid" };
  if (order.fulfillmentStatus && order.fulfillmentStatus !== "NOT_FULFILLED") return { kind: "skip", reason: "already_fulfilled" };

  const lines: WixLineItem[] = [];
  const ambiguous: string[] = [];
  for (const line of order.lineItems ?? []) {
    const c = classifyLine(line);
    if (c === "ship") lines.push(line);
    else if (c === "ambiguous") ambiguous.push(lineLabel(line));
  }
  if (ambiguous.length) {
    return {
      kind: "hold",
      code: "unknown_item_type",
      message: `${ref} held: line(s) marked shippable with unrecognised item type: ${ambiguous.join(", ")}`,
    };
  }
  if (!lines.length) return { kind: "non_physical" };

  const missingSku = lines.filter((l) => !l.physicalProperties?.sku?.trim()).map(lineLabel);
  if (missingSku.length) {
    return { kind: "hold", code: "missing_sku", message: `${ref} held: no SKU in Wix for ${missingSku.join(", ")}` };
  }
  const badQty = lines.filter((l) => !Number.isInteger(l.quantity) || (l.quantity ?? 0) < 1).map(lineLabel);
  if (badQty.length) {
    return { kind: "hold", code: "invalid_line", message: `${ref} held: invalid quantity for ${badQty.join(", ")}` };
  }

  const missing = missingAddressFields(deliveryAddress(order), deliveryContact(order));
  if (missing.length) {
    return { kind: "hold", code: "invalid_address", message: `${ref} held: delivery address missing ${missing.join(", ")}` };
  }

  return { kind: "ok", lines };
}

function missingAddressFields(
  addr: WixAddress | undefined,
  contact: { firstName?: string; lastName?: string; company?: string } | undefined,
): string[] {
  const missing: string[] = [];
  const has = (s?: string) => !!s?.trim();
  if (!has(contact?.firstName) && !has(contact?.lastName) && !has(contact?.company)) missing.push("name");
  const street = addr?.addressLine || [addr?.streetAddress?.number, addr?.streetAddress?.name].filter(Boolean).join(" ");
  if (!has(street)) missing.push("address line");
  if (!has(addr?.city)) missing.push("town");
  if (!has(addr?.country)) missing.push("country");
  else if (addr!.country!.toUpperCase() === "GB" && !has(addr?.postalCode)) missing.push("postcode");
  return missing;
}

function lineLabel(line: WixLineItem): string {
  const name = line.productName?.original ?? line.productName?.translated ?? "item";
  const sku = line.physicalProperties?.sku;
  return sku ? `${name} (${sku})` : name;
}
