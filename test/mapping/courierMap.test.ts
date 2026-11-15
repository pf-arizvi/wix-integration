import { describe, expect, it } from "vitest";
import { resolveCourier } from "../../src/mapping/courierMap";

const rules = [
  { wixShippingTitle: "Express Shipping", mintsoftCourierServiceId: 11, carrierDisplayName: "DPD" },
  { wixShippingTitle: "Standard", mintsoftCourierServiceId: 12, carrierDisplayName: "Royal Mail" },
];
const noDefault = { courierServiceId: null, carrierName: null };

describe("resolveCourier", () => {
  it("matches the Wix shipping title case-insensitively and trimmed", () => {
    expect(resolveCourier({ shippingInfo: { title: "  express   SHIPPING " } }, rules, noDefault)).toEqual({
      courierServiceId: 11,
      carrierDisplayName: "DPD",
      source: "map",
    });
  });

  it("falls back to matching the shipping code", () => {
    expect(resolveCourier({ shippingInfo: { title: "Unknown", code: "standard" } }, rules, noDefault)?.courierServiceId).toBe(12);
  });

  it("uses the client default when nothing matches", () => {
    expect(resolveCourier({ shippingInfo: { title: "Pigeon" } }, rules, { courierServiceId: 7, carrierName: "RM" })).toEqual({
      courierServiceId: 7,
      carrierDisplayName: "RM",
      source: "default",
    });
  });

  it("returns null (hold) with no match and no default", () => {
    expect(resolveCourier({ shippingInfo: { title: "Pigeon" } }, rules, noDefault)).toBeNull();
    expect(resolveCourier({}, [], noDefault)).toBeNull();
  });
});
