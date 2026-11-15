import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveOrderOutcome } from "../../src/db/orderMap";
import { handleCancel, handleDespatch } from "../../src/flows/pushTracking";
import { HttpError, SubrequestBudget } from "../../src/lib/http";
import { fakeCatalog, fakeDeps, fakeOrderSource, fakeWix, fakeWms, insertClient, resetDb, rows, wixOrder } from "../helpers";

const WIX_ID = "3887cf99-35e5-42d9-9be2-e6f98027845e";
const LINE = "00000000-0000-0000-0000-000000000001";

const payload = (o: Record<string, unknown> = {}) => ({
  ID: 41233,
  ClientId: 38,
  OrderNumber: "10002",
  ExternalOrderReference: WIX_ID,
  TrackingNumber: "AB123456789GB",
  TrackingURL: "https://www.royalmail.com/t/AB123456789GB",
  CourierServiceName: "Royal Mail Tracked 24",
  OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 2 }],
  ...o,
});

async function setup() {
  const client = await insertClient();
  await saveOrderOutcome(env.DB, { clientId: client.id, wixOrderId: WIX_ID, wixOrderNumber: "10002", status: "imported", mintsoftOrderId: 41233, countAttempt: true });
  const wix = fakeWix([wixOrder()]);
  const wms = fakeWms();
  const deps = fakeDeps(fakeOrderSource([]), wms, new SubrequestBudget(), fakeCatalog([]), wix);
  return { client, wix, wms, deps };
}

const orderRow = async () => (await rows<{ status: string; tracking_number: string | null }>("SELECT status, tracking_number FROM order_map"))[0];

beforeEach(resetDb);

describe("pushTracking — full despatch", () => {
  it("creates one Wix fulfilment with tracking and marks the order fulfilled", async () => {
    const { client, wix, deps } = await setup();
    const r = await handleDespatch(deps, client, payload());
    expect(r).toEqual({ outcome: "fulfilled", wixOrderNumber: "10002", mintsoftOrderId: 41233, tracked: true });
    expect(wix.requests).toEqual([
      {
        orderId: WIX_ID,
        req: {
          fulfillment: {
            lineItems: [{ id: LINE, quantity: 2 }],
            trackingInfo: { trackingNumber: "AB123456789GB", shippingProvider: "Royal Mail Tracked 24", trackingLink: "https://www.royalmail.com/t/AB123456789GB" },
          },
        },
      },
    ]);
    expect(await orderRow()).toEqual({ status: "fulfilled", tracking_number: "AB123456789GB" });
    expect(await rows("SELECT status, mintsoft_order_id, wix_fulfillment_id FROM fulfilments")).toEqual([
      { status: "created", mintsoft_order_id: 41233, wix_fulfillment_id: "f-1" },
    ]);
  });

  it("is idempotent: the same webhook twice creates one fulfilment", async () => {
    const { client, wix, deps } = await setup();
    await handleDespatch(deps, client, payload());
    const again = await handleDespatch(deps, client, payload());
    expect(again).toMatchObject({ outcome: "already_done" });
    expect(wix.requests).toHaveLength(1);
  });

  it("doesn't fulfil a replayed untracked partial despatch twice (only the fulfilments table can catch this)", async () => {
    const { client, wix, deps } = await setup();
    const part = payload({ TrackingNumber: undefined, TrackingURL: undefined, OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }] });
    expect(await handleDespatch(deps, client, part)).toMatchObject({ outcome: "partially_fulfilled" });
    // Same webhook again: Wix still shows 1 unfulfilled and there's no tracking number to dedupe on.
    expect(await handleDespatch(deps, client, part)).toMatchObject({ outcome: "already_done" });
    expect(wix.requests).toHaveLength(1);
  });

  it("treats Wix's duplicate-tracking 409 as success (lost response on a previous attempt)", async () => {
    const { client, wix, deps } = await setup();
    wix.fulfilments.set(WIX_ID, [{ id: "old", lineItems: [{ id: LINE, quantity: 1 }], trackingInfo: { trackingNumber: "AB123456789GB", shippingProvider: "Royal Mail Tracked 24" } }]);
    const r = await handleDespatch(deps, client, payload({ OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }] }));
    expect(r.outcome).not.toBe("error");
    expect(await rows("SELECT status FROM fulfilments")).toEqual([{ status: "created" }]);
  });

  it("names the carrier from carrier_names for the service actually used (real payload: name null, ID set)", async () => {
    const { client, wix, deps } = await setup();
    await env.DB.prepare("INSERT INTO carrier_names (mintsoft_courier_service_id, display_name) VALUES (1514, 'Collection in person')").run();
    await handleDespatch(deps, client, payload({ CourierServiceName: null, CourierServiceId: 1514 }));
    expect(wix.requests[0]!.req.fulfillment.trackingInfo!.shippingProvider).toBe("Collection in person");
  });

  it("uses the courier map's display name when the payload has no courier", async () => {
    const { client, wix, deps } = await setup();
    await env.DB.prepare(
      "INSERT INTO courier_map (client_id, wix_shipping_title, mintsoft_courier_service_id, carrier_display_name) VALUES (?1, 'Express Shipping', 14, 'Royal Mail')",
    ).bind(client.id).run();
    await handleDespatch(deps, client, payload({ CourierServiceName: undefined }));
    expect(wix.requests[0]!.req.fulfillment.trackingInfo!.shippingProvider).toBe("Royal Mail");
  });

  it("fulfils untracked despatches without tracking (agreed rule)", async () => {
    const { client, wix, deps } = await setup();
    const r = await handleDespatch(deps, client, payload({ TrackingNumber: undefined, TrackingURL: undefined }));
    expect(r).toMatchObject({ outcome: "fulfilled", tracked: false });
    expect(wix.requests[0]!.req.fulfillment.trackingInfo).toBeUndefined();
  });

  it("fetches the items from Mintsoft when the payload has none", async () => {
    const { client, wms, wix, deps } = await setup();
    wms.orderItems[41233] = [{ SKU: "BLKBAGMEDIUM", Quantity: 2 }];
    const { OrderItems: _omit, ...noItems } = payload();
    expect(await handleDespatch(deps, client, noItems)).toMatchObject({ outcome: "fulfilled" });
    expect(wix.requests[0]!.req.fulfillment.lineItems).toEqual([{ id: LINE, quantity: 2 }]);
  });
});

describe("pushTracking — split despatch (agreed: fulfil per part)", () => {
  it("part 1 → partially fulfilled, part 2 → fulfilled, each with its own tracking", async () => {
    const { client, wix, deps } = await setup();
    const p1 = await handleDespatch(deps, client, payload({ ID: 41233, TrackingNumber: "TRK1", OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }] }));
    expect(p1).toMatchObject({ outcome: "partially_fulfilled" });
    expect((await orderRow())!.status).toBe("despatched");

    // The split part is a separate Mintsoft order, matched via ExternalOrderReference.
    const p2 = await handleDespatch(deps, client, payload({ ID: 41240, TrackingNumber: "TRK2", OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }] }));
    expect(p2).toMatchObject({ outcome: "fulfilled", mintsoftOrderId: 41240 });
    expect(wix.requests.map((r) => r.req.fulfillment.trackingInfo!.trackingNumber)).toEqual(["TRK1", "TRK2"]);
    expect(await orderRow()).toEqual({ status: "fulfilled", tracking_number: "TRK2" });
    expect(await rows("SELECT mintsoft_order_id FROM fulfilments ORDER BY mintsoft_order_id")).toEqual([{ mintsoft_order_id: 41233 }, { mintsoft_order_id: 41240 }]);
  });
});

describe("pushTracking — failures and guardrails", () => {
  it("never touches Wix for a despatch belonging to another Mintsoft client", async () => {
    const { client, wix, deps } = await setup();
    const r = await handleDespatch(deps, client, payload({ ClientId: 39 }));
    expect(r).toMatchObject({ outcome: "error", code: "mintsoft_client_mismatch" });
    expect(wix.requests).toHaveLength(0);
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_client_mismatch" }]);
  });

  it("records order_not_found with the payload keys when nothing matches", async () => {
    const { client, wix, deps } = await setup();
    const r = await handleDespatch(deps, client, { ID: 999, OrderNumber: "77777", Weird: true });
    expect(r).toMatchObject({ outcome: "error", code: "order_not_found" });
    if (r.outcome === "error") expect(r.message).toContain("ID, OrderNumber, Weird");
    expect(wix.requests).toHaveLength(0);
  });

  it("matches by Mintsoft order ID or order number when ExternalOrderReference is missing", async () => {
    const { client, deps } = await setup();
    expect(await handleDespatch(deps, client, payload({ ExternalOrderReference: undefined }))).toMatchObject({ outcome: "fulfilled" });
  });

  it("marks fulfil_failed (for reconcile to retry) when Wix errors, then succeeds on retry", async () => {
    const { client, wix, deps } = await setup();
    wix.failNextCreate = new HttpError({ kind: "http", status: 500, service: "wix", method: "POST", url: "x", attempts: 1 });
    const r1 = await handleDespatch(deps, client, payload());
    expect(r1).toMatchObject({ outcome: "error", code: "wix_api_error" });
    expect((await orderRow())!.status).toBe("fulfil_failed");
    expect(await rows("SELECT status, attempts FROM fulfilments")).toEqual([{ status: "failed", attempts: 1 }]);

    const r2 = await handleDespatch(deps, client, payload());
    expect(r2).toMatchObject({ outcome: "fulfilled" });
    expect(await rows("SELECT status, attempts FROM fulfilments")).toEqual([{ status: "created", attempts: 2 }]);
  });

  it("does not fulfil a cancelled Wix order", async () => {
    const { client, wix, deps } = await setup();
    wix.orders.set(WIX_ID, wixOrder({ status: "CANCELED" }));
    expect(await handleDespatch(deps, client, payload())).toMatchObject({ outcome: "error", code: "order_cancelled" });
    expect(wix.requests).toHaveLength(0);
  });

  it("records already-fulfilled Wix orders as done without creating anything", async () => {
    const { client, wix, deps } = await setup();
    wix.fulfilments.set(WIX_ID, [{ id: "manual", lineItems: [{ id: LINE, quantity: 2 }] }]);
    expect(await handleDespatch(deps, client, payload())).toMatchObject({ outcome: "already_done" });
    expect(wix.requests).toHaveLength(0);
    expect((await orderRow())!.status).toBe("fulfilled");
  });
});

describe("handleCancel", () => {
  it("logs a mintsoft_cancelled error and changes nothing in Wix", async () => {
    const { client, wix, deps } = await setup();
    await handleCancel(deps, client, payload());
    expect(await rows("SELECT code, ref FROM error_log")).toEqual([{ code: "mintsoft_cancelled", ref: "10002" }]);
    expect(wix.requests).toHaveLength(0);
  });
});
