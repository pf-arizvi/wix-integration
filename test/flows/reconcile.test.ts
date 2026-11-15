import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { MintsoftOrder } from "../../src/adapters/mintsoft/types";
import { listActiveClients } from "../../src/db/clients";
import { saveOrderOutcome } from "../../src/db/orderMap";
import { getSyncState, setSyncState } from "../../src/db/syncState";
import { reconcileOnce, toMintsoftDate } from "../../src/flows/reconcile";
import { HttpError, SubrequestBudget } from "../../src/lib/http";
import { fakeCatalog, fakeDeps, fakeOrderSource, fakeWix, fakeWms, insertClient, resetDb, rows, wixOrder } from "../helpers";

const WIX_ID = "3887cf99-35e5-42d9-9be2-e6f98027845e";

/** Shaped like the real Order/List item for Mintsoft order 41233 (no OrderItems in list results). */
const listed = (o: Partial<MintsoftOrder> = {}): MintsoftOrder => ({
  ID: 41233,
  ClientId: 38,
  OrderNumber: "10002",
  ExternalOrderReference: WIX_ID,
  DespatchDate: "2026-11-15T20:04:38.6920379",
  TrackingNumber: "123456789",
  TrackingURL: "",
  CourierServiceId: 1514,
  ...o,
});

async function setup() {
  const client = await insertClient();
  await setSyncState(env.DB, client.id, "reconcile_since", "2026-11-15T19:00:00");
  await saveOrderOutcome(env.DB, { clientId: client.id, wixOrderId: WIX_ID, wixOrderNumber: "10002", status: "imported", mintsoftOrderId: 41233, countAttempt: true });
  const wms = fakeWms();
  wms.orderItems[41233] = [{ SKU: "BLKBAGMEDIUM", Quantity: 2 }];
  const wix = fakeWix([wixOrder()]);
  const deps = fakeDeps(fakeOrderSource([]), wms, new SubrequestBudget(), fakeCatalog([]), wix);
  return { client, wms, wix, deps, clients: await listActiveClients(env.DB) };
}

beforeEach(resetDb);

describe("reconcile", () => {
  it("fulfils a despatched order the webhook missed, and advances the cursor", async () => {
    const { wms, wix, deps, clients, client } = await setup();
    wms.despatched.push(listed());
    const r = await reconcileOnce(deps, clients);
    expect(r).toMatchObject({ since: "2026-11-15T17:00:00", pagesRead: 1, despatchedSeen: 1, ours: 1, stoppedBy: null });
    expect(r.results).toEqual([{ outcome: "fulfilled", wixOrderNumber: "10002", mintsoftOrderId: 41233, tracked: true, source: "despatched" }]);
    expect(wix.requests).toHaveLength(1);
    expect(wix.requests[0]!.req.fulfillment.trackingInfo).toEqual({ trackingNumber: "123456789", shippingProvider: "Royal Mail" }); // no link: URL was ""
    expect(await getSyncState(env.DB, client.id, "reconcile_since")).toBe("2026-11-15T20:04:38");
    expect(wms.listCalls[0]).toEqual({ since: "2026-11-15T17:00:00", page: 1 });
  });

  it("is idempotent with the webhook: an order already fulfilled is skipped without any Wix call", async () => {
    const { wms, wix, deps, clients } = await setup();
    wms.despatched.push(listed());
    await reconcileOnce(deps, clients);
    const again = await reconcileOnce({ ...deps, budget: new SubrequestBudget() }, clients);
    expect(again.results).toEqual([]);
    expect(wix.requests).toHaveLength(1);
  });

  it("ignores other 3PL clients' orders and this client's orders from other channels", async () => {
    const { wms, wix, deps, clients } = await setup();
    wms.despatched.push(
      listed({ ID: 900, ClientId: 39, ExternalOrderReference: "other-client", OrderNumber: "A1" }),
      listed({ ID: 901, ExternalOrderReference: "amazon-123", OrderNumber: "AMZ-1" }),
    );
    const r = await reconcileOnce(deps, clients);
    expect(r).toMatchObject({ despatchedSeen: 2, ours: 0, results: [] });
    expect(wix.requests).toHaveLength(0);
    expect(await rows("SELECT * FROM error_log")).toHaveLength(0); // not ours = not an error
  });

  it("picks up split parts (separate Mintsoft orders) via ExternalOrderReference", async () => {
    const { wms, wix, deps, clients } = await setup();
    wms.orderItems[41233] = [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }];
    wms.orderItems[41240] = [{ SKU: "BLKBAGMEDIUM", Quantity: 1 }];
    wms.despatched.push(listed({ TrackingNumber: "P1" }), listed({ ID: 41240, TrackingNumber: "P2", DespatchDate: "2026-11-15T20:30:00" }));
    const r = await reconcileOnce(deps, clients);
    expect(r.results.map((x) => x.outcome)).toEqual(["partially_fulfilled", "fulfilled"]);
    expect(wix.requests.map((q) => q.req.fulfillment.trackingInfo!.trackingNumber)).toEqual(["P1", "P2"]);
  });

  it("retries failed fulfilments", async () => {
    const { wms, wix, deps, clients, client } = await setup();
    wms.store.push({ ID: 41233, ClientId: 38, OrderNumber: "10002", ExternalOrderReference: WIX_ID, TrackingNumber: "123456789" } as MintsoftOrder);
    await env.DB.prepare(
      "INSERT INTO fulfilments (client_id, wix_order_id, mintsoft_order_id, status, attempts) VALUES (?1, ?2, 41233, 'failed', 1)",
    ).bind(client.id, WIX_ID).run();
    const r = await reconcileOnce(deps, clients);
    expect(r.results).toEqual([expect.objectContaining({ outcome: "fulfilled", source: "retry", mintsoftOrderId: 41233 })]);
    expect(wix.requests).toHaveLength(1);
  });

  it("stops before an order it can't finish within the budget, and doesn't advance past it", async () => {
    const { wms, deps, clients, client } = await setup();
    wms.despatched.push(listed());
    const r = await reconcileOnce({ ...deps, budget: new SubrequestBudget(3) }, clients);
    expect(r).toMatchObject({ stoppedBy: "subrequest_budget", results: [] });
    expect(await getSyncState(env.DB, client.id, "reconcile_since")).toBe("2026-11-15T19:00:00");
  });

  it("does nothing with no active clients", async () => {
    const { deps, wms } = await setup();
    expect(await reconcileOnce(deps, [])).toMatchObject({ pagesRead: 0 });
    expect(wms.listCalls).toHaveLength(0);
  });

  it("surfaces a Mintsoft list failure to the caller", async () => {
    const { wms, deps, clients } = await setup();
    wms.listDespatchedSince = async () => {
      throw new HttpError({ kind: "http", status: 500, service: "mintsoft", method: "GET", url: "x", attempts: 3 });
    };
    await expect(reconcileOnce(deps, clients)).rejects.toMatchObject({ status: 500 });
  });
});

describe("toMintsoftDate", () => {
  it("formats without a zone or milliseconds", () => {
    expect(toMintsoftDate(Date.parse("2026-11-15T20:04:38.692Z"))).toBe("2026-11-15T20:04:38");
  });
});
