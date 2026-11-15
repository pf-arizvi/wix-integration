import { describe, expect, it } from "vitest";
import { parseDespatchPayload, planFulfilment, remainingByLine } from "../../src/mapping/trackingMapper";
import { wixOrder } from "../helpers";

/** Shaped like GET /api/Order/{id} (Swagger: Order) for Mintsoft order 41233. */
const despatchPayload = {
  ID: 41233,
  ClientId: 38,
  OrderNumber: "10002",
  ExternalOrderReference: "3887cf99-35e5-42d9-9be2-e6f98027845e",
  TrackingNumber: "AB123456789GB",
  TrackingURL: "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB",
  CourierServiceName: "Royal Mail Tracked 24",
  OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 2 }],
  FirstName: "should-not-matter",
};

const LINE = "00000000-0000-0000-0000-000000000001";

describe("parseDespatchPayload", () => {
  it("reads the Swagger Order shape", () => {
    expect(parseDespatchPayload(despatchPayload)).toMatchObject({
      mintsoftOrderId: 41233,
      mintsoftClientId: 38,
      orderNumber: "10002",
      externalOrderReference: "3887cf99-35e5-42d9-9be2-e6f98027845e",
      trackingNumber: "AB123456789GB",
      trackingUrl: "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB",
      courierName: "Royal Mail Tracked 24",
      items: [{ sku: "BLKBAGMEDIUM", quantity: 2 }],
    });
  });

  it("tolerates renamed/recased fields, wrappers and arrays", () => {
    const d = parseDespatchPayload([{ order: { id: "41233", trackingno: "X1", trackingUrl: "https://t", CourierService: { Name: "DPD" }, items: [{ sku: "A", qty: "3" }] } }]);
    expect(d).toMatchObject({ mintsoftOrderId: 41233, trackingNumber: "X1", trackingUrl: "https://t", courierName: "DPD", items: [{ sku: "A", quantity: 3 }] });
  });

  it("reports which keys arrived (names only) and nulls for what's missing", () => {
    const d = parseDespatchPayload({ Foo: 1, Bar: "x" });
    expect(d).toMatchObject({ mintsoftOrderId: null, trackingNumber: null, items: null, keys: ["Bar", "Foo"] });
    expect(parseDespatchPayload("nonsense").keys).toEqual([]);
  });

  it("returns items: null when the payload has no item list", () => {
    const { OrderItems: _omit, ...noItems } = despatchPayload;
    expect(parseDespatchPayload(noItems).items).toBeNull();
  });
});

describe("planFulfilment", () => {
  const tracking = { number: "AB123456789GB", url: "https://www.royalmail.com/t/AB123456789GB", provider: "Royal Mail Tracked 24" };

  it("fulfils a full despatch with tracking", () => {
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking });
    expect(plan).toEqual({
      kind: "create",
      completesOrder: true,
      unmatched: [],
      request: {
        fulfillment: {
          lineItems: [{ id: LINE, quantity: 2 }],
          trackingInfo: { trackingNumber: "AB123456789GB", shippingProvider: "Royal Mail Tracked 24", trackingLink: tracking.url },
        },
      },
    });
  });

  it("fulfils a partial despatch and leaves the rest unfulfilled", () => {
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 1 }], tracking });
    expect(plan).toMatchObject({ kind: "create", completesOrder: false, request: { fulfillment: { lineItems: [{ id: LINE, quantity: 1 }] } } });
  });

  it("completes the order when the second part ships", () => {
    const existing = [{ id: "f1", lineItems: [{ id: LINE, quantity: 1 }] }];
    expect(remainingByLine(wixOrder(), existing).get(LINE)).toBe(1);
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: existing, despatched: [{ sku: "BLKBAGMEDIUM", quantity: 1 }], tracking });
    expect(plan).toMatchObject({ kind: "create", completesOrder: true });
  });

  it("caps at what's still unfulfilled and reports the excess", () => {
    const existing = [{ id: "f1", lineItems: [{ id: LINE, quantity: 1 }] }];
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: existing, despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking });
    expect(plan).toMatchObject({
      kind: "create",
      completesOrder: true,
      request: { fulfillment: { lineItems: [{ id: LINE, quantity: 1 }] } },
      unmatched: [{ sku: "BLKBAGMEDIUM", quantity: 1 }],
    });
  });

  it("ignores fulfilments marked completed: false", () => {
    const existing = [{ id: "f1", completed: false, lineItems: [{ id: LINE, quantity: 2 }] }];
    expect(remainingByLine(wixOrder(), existing).get(LINE)).toBe(2);
  });

  it("fulfils untracked despatches without tracking info (agreed rule)", () => {
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking: null });
    expect(plan).toMatchObject({ kind: "create", request: { fulfillment: { customInfo: { fieldsData: { tracking: "Untracked" } } } } });
    if (plan.kind === "create") expect(plan.request.fulfillment.trackingInfo).toBeUndefined();
  });

  it("omits an invalid tracking link rather than failing", () => {
    const plan = planFulfilment({ wixOrder: wixOrder(), existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking: { ...tracking, url: "not a url" } });
    if (plan.kind !== "create") throw new Error("expected create");
    expect(plan.request.fulfillment.trackingInfo).toEqual({ trackingNumber: "AB123456789GB", shippingProvider: "Royal Mail Tracked 24" });
  });

  it("reports nothing_remaining when the order is already fully fulfilled", () => {
    const existing = [{ id: "f1", lineItems: [{ id: LINE, quantity: 2 }] }];
    expect(planFulfilment({ wixOrder: wixOrder(), existingFulfilments: existing, despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking })).toEqual({ kind: "nothing_remaining" });
  });

  it("errors when despatched SKUs don't match the Wix order", () => {
    expect(planFulfilment({ wixOrder: wixOrder(), existingFulfilments: [], despatched: [{ sku: "OTHER", quantity: 1 }], tracking })).toMatchObject({
      kind: "error",
      code: "despatch_mismatch",
    });
  });

  it("never fulfils a cancelled Wix order", () => {
    expect(planFulfilment({ wixOrder: wixOrder({ status: "CANCELED" }), existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 2 }], tracking })).toMatchObject({
      kind: "error",
      code: "order_cancelled",
    });
  });

  it("splits a SKU across two Wix lines with the same SKU", () => {
    const o = wixOrder();
    o.lineItems!.push({ ...o.lineItems![0]!, id: "line-2", quantity: 1 });
    const plan = planFulfilment({ wixOrder: o, existingFulfilments: [], despatched: [{ sku: "BLKBAGMEDIUM", quantity: 3 }], tracking });
    expect(plan).toMatchObject({
      kind: "create",
      completesOrder: true,
      request: { fulfillment: { lineItems: [{ id: LINE, quantity: 2 }, { id: "line-2", quantity: 1 }] } },
    });
  });
});
