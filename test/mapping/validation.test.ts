import { describe, expect, it } from "vitest";
import { classifyLine, validateWixOrder } from "../../src/mapping/validation";
import { wixOrder } from "../helpers";

describe("validateWixOrder", () => {
  it("accepts the fixture order", () => {
    const v = validateWixOrder(wixOrder());
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.lines).toHaveLength(1);
  });

  it("never imports cancelled, unpaid or fulfilled orders", () => {
    expect(validateWixOrder(wixOrder({ status: "CANCELED" }))).toEqual({ kind: "skip", reason: "cancelled" });
    expect(validateWixOrder(wixOrder({ paymentStatus: "NOT_PAID" }))).toEqual({ kind: "skip", reason: "not_paid" });
    expect(validateWixOrder(wixOrder({ fulfillmentStatus: "FULFILLED" }))).toEqual({ kind: "skip", reason: "already_fulfilled" });
  });

  it("holds the WHOLE order when any shippable line has no SKU", () => {
    const o = wixOrder();
    o.lineItems!.push({ ...o.lineItems![0]!, id: "2", productName: { original: "No SKU thing" }, physicalProperties: { shippable: true } });
    const v = validateWixOrder(o);
    expect(v).toMatchObject({ kind: "hold", code: "missing_sku" });
    if (v.kind === "hold") expect(v.message).toContain("Order 10002 held");
  });

  it("reports orders with only non-physical lines", () => {
    const o = wixOrder();
    o.lineItems = [{ id: "1", quantity: 1, itemType: { preset: "DIGITAL" }, physicalProperties: { shippable: false } }];
    expect(validateWixOrder(o)).toEqual({ kind: "non_physical" });
  });

  it("holds when a shippable line has an unrecognised item type (no silent drop)", () => {
    const o = wixOrder();
    o.lineItems![0]!.itemType = { custom: "some-app-item" };
    expect(validateWixOrder(o)).toMatchObject({ kind: "hold", code: "unknown_item_type" });
  });

  it("holds on bad quantities", () => {
    const o = wixOrder();
    o.lineItems![0]!.quantity = 0;
    expect(validateWixOrder(o)).toMatchObject({ kind: "hold", code: "invalid_line" });
  });

  it("holds on incomplete delivery addresses, naming the missing fields", () => {
    const o = wixOrder();
    o.recipientInfo!.address = { country: "GB", city: "London" };
    const v = validateWixOrder(o);
    expect(v).toMatchObject({ kind: "hold", code: "invalid_address" });
    if (v.kind === "hold") expect(v.message).toMatch(/address line.*postcode/);
  });
});

describe("classifyLine", () => {
  it.each([
    [{ itemType: { preset: "PHYSICAL" }, physicalProperties: { shippable: true } }, "ship"],
    [{ itemType: { preset: "PHYSICAL" }, physicalProperties: { shippable: false } }, "skip"],
    [{ itemType: { preset: "GIFT_CARD" } }, "skip"],
    [{ itemType: { preset: "SERVICE" }, physicalProperties: { shippable: true } }, "skip"],
    [{ itemType: { custom: "x" }, physicalProperties: { shippable: true } }, "ambiguous"],
    [{ itemType: { custom: "x" } }, "skip"],
  ] as const)("%j → %s", (line, expected) => {
    expect(classifyLine({ id: "1", ...line })).toBe(expected);
  });
});
