/**
 * Pure: resolve a Wix shipping option → Mintsoft CourierServiceId (SPEC §4.1).
 * Match on shippingInfo.title, then shippingInfo.code (case-insensitive, trimmed,
 * internal whitespace collapsed). No match → client default. No default → null (hold).
 */
import type { WixOrder } from "../adapters/wix/types";

export interface CourierRule {
  wixShippingTitle: string;
  mintsoftCourierServiceId: number;
  carrierDisplayName: string | null;
}

export interface ResolvedCourier {
  courierServiceId: number;
  carrierDisplayName: string | null;
  source: "map" | "default";
}

export function normaliseShippingTitle(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function resolveCourier(
  order: Pick<WixOrder, "shippingInfo">,
  rules: readonly CourierRule[],
  defaults: { courierServiceId: number | null; carrierName: string | null },
): ResolvedCourier | null {
  const keys = [order.shippingInfo?.title, order.shippingInfo?.code]
    .filter((s): s is string => !!s?.trim())
    .map(normaliseShippingTitle);
  for (const key of keys) {
    const rule = rules.find((r) => normaliseShippingTitle(r.wixShippingTitle) === key);
    if (rule) {
      return { courierServiceId: rule.mintsoftCourierServiceId, carrierDisplayName: rule.carrierDisplayName, source: "map" };
    }
  }
  if (defaults.courierServiceId != null) {
    return { courierServiceId: defaults.courierServiceId, carrierDisplayName: defaults.carrierName, source: "default" };
  }
  return null;
}
