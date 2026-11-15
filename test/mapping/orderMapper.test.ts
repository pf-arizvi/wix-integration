import { describe, expect, it } from "vitest";
import { mapWixOrderToMintsoft, mintsoftOrderNumber, money, normalisePostcode } from "../../src/mapping/orderMapper";
import { validateWixOrder } from "../../src/mapping/validation";
import type { WixOrder } from "../../src/adapters/wix/types";
import { wixOrder } from "../helpers";

const ctx = {
  mintsoftClientId: 38,
  mintsoftWarehouseId: 3,
  orderNumberPrefix: "",
  courierServiceId: 7,
  despatchWebhookUrl: "https://worker.test/webhooks/mintsoft/despatch/wix-test?token=t",
  cancelWebhookUrl: "https://worker.test/webhooks/mintsoft/cancel/wix-test?token=t",
};

function map(order: WixOrder, c = ctx) {
  const v = validateWixOrder(order);
  if (v.kind !== "ok") throw new Error(`fixture not valid: ${JSON.stringify(v)}`);
  return mapWixOrderToMintsoft(order, v.lines, c);
}

describe("mapWixOrderToMintsoft — fixture order 10002", () => {
  it("maps every field per SPEC §4.1", () => {
    expect(map(wixOrder())).toEqual({
      ClientId: 38,
      OrderNumber: "10002",
      ExternalOrderReference: "3887cf99-35e5-42d9-9be2-e6f98027845e",
      FirstName: "Test",
      LastName: "Buyer",
      Address1: "1 Test Street",
      Town: "London",
      PostCode: "SW1A 1AA",
      Country: "GB",
      Email: "test.buyer@example.com",
      Phone: "+447700900000",
      CourierServiceId: 7,
      WarehouseId: 3,
      Currency: "GBP",
      OrderValue: 205,
      ShippingTotalExVat: 5,
      TotalVat: 0,
      OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 2, UnitPrice: 100 }],
      ConnectAction: {
        Type: "API",
        SourceOrderId: "10002",
        Complete: false,
        ExtraCode1: ctx.despatchWebhookUrl,
        ExtraCode2: ctx.cancelWebhookUrl,
      },
    });
  });

  it("omits County for GB but sends it elsewhere", () => {
    expect(map(wixOrder()).County).toBeUndefined();
    const ie = wixOrder();
    ie.recipientInfo!.address = { country: "IE", city: "Dublin", addressLine: "1 Main St", postalCode: "d02 x285", subdivisionFullname: "County Dublin" };
    const out = map(ie);
    expect(out.County).toBe("County Dublin");
    expect(out.PostCode).toBe("D02 X285");
  });

  it("applies the client order-number prefix", () => {
    expect(map(wixOrder(), { ...ctx, orderNumberPrefix: "WX-" }).OrderNumber).toBe("WX-10002");
    expect(mintsoftOrderNumber({ number: "1" }, "")).toBe("1");
  });

  it("puts the buyer note in Comments", () => {
    expect(map(wixOrder({ buyerNote: "  Leave with neighbour  " })).Comments).toBe("Leave with neighbour");
  });

  it("uses recipientInfo, never billingInfo, for the delivery address", () => {
    const gift = wixOrder();
    gift.billingInfo!.address!.addressLine = "99 Payer Road";
    gift.billingInfo!.contactDetails = { firstName: "Payer", lastName: "Person" };
    const out = map(gift);
    expect(out.Address1).toBe("1 Test Street");
    expect(out.FirstName).toBe("Test");
  });

  it("falls back to the shipping destination when recipientInfo is missing", () => {
    const o = wixOrder();
    delete o.recipientInfo;
    o.shippingInfo!.logistics!.shippingDestination!.address!.addressLine = "2 Dest Lane";
    expect(map(o).Address1).toBe("2 Dest Lane");
  });

  it("builds Address1 from streetAddress when addressLine is missing", () => {
    const o = wixOrder();
    o.recipientInfo!.address = { ...o.recipientInfo!.address, addressLine: undefined, streetAddress: { number: "10", name: "Downing Street" } };
    expect(map(o).Address1).toBe("10 Downing Street");
  });

  it("only sends shippable physical lines", () => {
    const o = wixOrder();
    o.lineItems!.push({
      id: "gift",
      productName: { original: "Gift card" },
      quantity: 1,
      physicalProperties: { shippable: false },
      itemType: { preset: "GIFT_CARD" },
      price: { amount: "10.00" },
    });
    expect(map(o).OrderItems).toEqual([{ SKU: "BLKBAGMEDIUM", Quantity: 2, UnitPrice: 100 }]);
  });

  it("never includes stock or VAT-per-line fields", () => {
    const item = map(wixOrder()).OrderItems[0]!;
    expect(Object.keys(item).sort()).toEqual(["Quantity", "SKU", "UnitPrice"]);
  });
});

describe("normalisePostcode", () => {
  it.each([
    ["HA54DF", "GB", "HA5 4DF"],
    ["ha5 4df", "GB", "HA5 4DF"],
    ["SW1A1AA", "GB", "SW1A 1AA"],
    [" m1  1ae ", "GB", "M1 1AE"],
    ["JE24WD", "JE", "JE2 4WD"],
    ["10115", "DE", "10115"],
  ])("%s (%s) → %s", (input, country, expected) => {
    expect(normalisePostcode(input, country)).toBe(expected);
  });
  it("returns undefined for empty", () => {
    expect(normalisePostcode("  ", "GB")).toBeUndefined();
  });
});

describe("money", () => {
  it("parses Wix string amounts", () => {
    expect(money({ amount: "205.00" })).toBe(205);
    expect(money({ amount: "" })).toBeUndefined();
    expect(money({ amount: "abc" })).toBeUndefined();
    expect(money(undefined)).toBeUndefined();
  });
});
