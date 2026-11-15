import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getClientBySlug } from "../../src/db/clients";
import { upsertCourierRules } from "../../src/db/courierMap";
import { getSyncState } from "../../src/db/syncState";
import { ImportConfigError, ImportHaltedError, importOrdersForClient } from "../../src/flows/importOrders";
import { HttpError, SubrequestBudget } from "../../src/lib/http";
import { fakeDeps, fakeOrderSource, fakeWms, insertClient, resetDb, rows, wixOrder } from "../helpers";

const run = (deps: Parameters<typeof importOrdersForClient>[0], client: Parameters<typeof importOrdersForClient>[1], opts = {}) =>
  importOrdersForClient(deps, client, { limit: 15, dryRun: false, ...opts });

const orderN = (n: number, minute: number) =>
  wixOrder({ id: `wix-${n}`, number: String(10000 + n), updatedDate: `2026-11-15T12:${String(minute).padStart(2, "0")}:00.000Z` });

beforeEach(resetDb);

describe("importOrders — happy path and idempotency", () => {
  it("imports the fixture order once; a re-run creates nothing new", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const source = fakeOrderSource([wixOrder()]);

    const r1 = await run(fakeDeps(source, wms), client);
    expect(r1.outcomes).toEqual([{ wixOrderNumber: "10002", outcome: "imported", mintsoftOrderId: 5000, warehouseId: 1, channelId: 2 }]);
    expect(wms.created).toHaveLength(1);
    expect(wms.created[0]!.ConnectAction!.ExtraCode1).toBe("https://worker.test/webhooks/mintsoft/despatch/wix-test?token=tok_test");

    const [row] = await rows<{ status: string; mintsoft_order_id: number; attempts: number }>("SELECT * FROM order_map");
    expect(row).toMatchObject({ status: "imported", mintsoft_order_id: 5000, attempts: 1 });
    expect(await getSyncState(env.DB, client.id, "orders_cursor")).toBe("2026-11-15T11:55:07.542Z");

    const r2 = await run(fakeDeps(source, wms), client);
    expect(r2).toMatchObject({ ordersSeen: 1, alreadyHandled: 1, processed: 0 });
    expect(wms.created).toHaveLength(1);
  });

  it("does not create when the order already exists in Mintsoft for this client (lost response)", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    wms.store.push({ ID: 777, ClientId: 38, OrderNumber: "10002" });
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(r.outcomes).toEqual([{ wixOrderNumber: "10002", outcome: "already_in_mintsoft", mintsoftOrderId: 777 }]);
    expect(wms.created).toHaveLength(0);
    expect((await rows("SELECT status, mintsoft_order_id FROM order_map"))[0]).toEqual({ status: "imported", mintsoft_order_id: 777 });
  });

  it("ignores same-numbered orders belonging to other Mintsoft clients", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    wms.store.push({ ID: 1, ClientId: 39, OrderNumber: "10002" });
    await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(wms.created).toHaveLength(1);
  });

  it("recovers from a create timeout without duplicating", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const source = fakeOrderSource([wixOrder()]);
    // Mintsoft creates the order but the response is lost.
    wms.createImpl = async (o) => {
      wms.store.push({ ID: 901, ClientId: o.ClientId, OrderNumber: o.OrderNumber });
      throw new HttpError({ kind: "timeout", service: "mintsoft", method: "PUT", url: "https://api.mintsoft.co.uk/api/Order", attempts: 1 });
    };
    const r1 = await run(fakeDeps(source, wms), client);
    expect(r1.outcomes[0]).toMatchObject({ outcome: "held", code: "mintsoft_api_error" });

    wms.createImpl = async () => {
      throw new Error("must not be called again");
    };
    const r2 = await run(fakeDeps(source, wms), client);
    expect(r2.outcomes[0]).toMatchObject({ outcome: "already_in_mintsoft", mintsoftOrderId: 901 });
    expect((await rows("SELECT status, attempts FROM order_map"))[0]).toEqual({ status: "imported", attempts: 2 });
  });
});

describe("importOrders — dry run writes nothing", () => {
  it("returns the would-be payload and leaves Mintsoft, order_map, error_log and cursor untouched", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.outcomes[0]).toMatchObject({ outcome: "would_import", payload: { ClientId: 38, OrderNumber: "10002", CourierServiceId: 7 } });
    expect(wms.created).toHaveLength(0);
    expect(await rows("SELECT * FROM order_map")).toHaveLength(0);
    expect(await rows("SELECT * FROM error_log")).toHaveLength(0);
    expect(r.cursorTo).toBeNull();
    expect(await getSyncState(env.DB, client.id, "orders_cursor")).toBe("2026-11-15T00:00:00.000Z");
  });

  it("is forced when writes are disabled, even if dryRun=false is requested", async () => {
    const client = await insertClient();
    const wms = fakeWms({ writesEnabled: false });
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client, { dryRun: false });
    expect(r.dryRun).toBe(true);
    expect(r.outcomes[0]!.outcome).toBe("would_import");
    expect(await rows("SELECT * FROM order_map")).toHaveLength(0);
  });

  it("still reports holds in a dry run without recording them", async () => {
    const client = await insertClient();
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), fakeWms({ skus: [] })), client, { dryRun: true });
    expect(r.outcomes[0]).toMatchObject({ outcome: "held", code: "unknown_sku" });
    expect(await rows("SELECT * FROM error_log")).toHaveLength(0);
  });
});

describe("importOrders — holds", () => {
  it("holds the whole order on an unknown SKU, then imports it once the SKU exists", async () => {
    const client = await insertClient();
    const wms = fakeWms({ skus: [] });
    const source = fakeOrderSource([wixOrder()]);

    const r1 = await run(fakeDeps(source, wms), client);
    expect(r1.outcomes[0]).toMatchObject({ outcome: "held", code: "unknown_sku", message: "Order 10002 held: SKU BLKBAGMEDIUM not found in Mintsoft client 38" });
    expect(wms.created).toHaveLength(0);
    expect(await rows("SELECT code, ref, flow FROM error_log")).toEqual([{ code: "unknown_sku", ref: "10002", flow: "importOrders" }]);

    wms.skus.add("BLKBAGMEDIUM");
    const r2 = await run(fakeDeps(source, wms), client);
    expect(r2.outcomes[0]!.outcome).toBe("imported");
    expect((await rows("SELECT status, attempts FROM order_map"))[0]).toEqual({ status: "imported", attempts: 2 });
  });

  it("stops retrying a held order after 5 attempts", async () => {
    const client = await insertClient();
    const wms = fakeWms({ skus: [] });
    const source = fakeOrderSource([wixOrder()]);
    for (let i = 0; i < 5; i++) await run(fakeDeps(source, wms), client);
    const r = await run(fakeDeps(source, wms), client);
    expect(r).toMatchObject({ processed: 0, alreadyHandled: 1 });
    expect((await rows("SELECT attempts FROM order_map"))[0]).toEqual({ attempts: 5 });
  });

  it("holds when the shipping method is unmapped and the client has no default", async () => {
    const client = await insertClient({ defaultCourierServiceId: null });
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), fakeWms()), client);
    expect(r.outcomes[0]).toMatchObject({ outcome: "held", code: "unmapped_courier" });
  });

  it("uses the courier map before the client default", async () => {
    const client = await insertClient();
    await upsertCourierRules(env.DB, client.id, [{ wixShippingTitle: "express shipping", mintsoftCourierServiceId: 42, carrierDisplayName: "DPD" }]);
    const wms = fakeWms();
    await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(wms.created[0]!.CourierServiceId).toBe(42);
  });

  it("holds when Mintsoft rejects the order", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    wms.createImpl = async () => ({ Success: false, Message: "Invalid courier" });
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(r.outcomes[0]).toMatchObject({ outcome: "held", code: "mintsoft_rejected" });
  });

  it("records non-physical orders as skipped_non_physical", async () => {
    const client = await insertClient();
    const o = wixOrder();
    o.lineItems = [{ id: "1", quantity: 1, itemType: { preset: "DIGITAL" } }];
    const r = await run(fakeDeps(fakeOrderSource([o]), fakeWms()), client);
    expect(r.outcomes[0]!.outcome).toBe("skipped_non_physical");
    expect((await rows("SELECT status FROM order_map"))[0]).toEqual({ status: "skipped_non_physical" });
  });
});

describe("importOrders — batch caps and cursor", () => {
  it("respects the order cap and never advances the cursor past an unprocessed order", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const source = fakeOrderSource([orderN(1, 1), orderN(2, 2), orderN(3, 3)]);

    const r1 = await run(fakeDeps(source, wms), client, { limit: 2 });
    expect(r1).toMatchObject({ processed: 2, stoppedBy: "order_cap", cursorTo: "2026-11-15T12:02:00.000Z" });

    const r2 = await run(fakeDeps(source, wms), client, { limit: 2 });
    expect(r2).toMatchObject({ processed: 1, alreadyHandled: 2, stoppedBy: null });
    expect(wms.created.map((o) => o.OrderNumber)).toEqual(["10001", "10002", "10003"]);
  });

  it("pages through already-handled orders to reach new ones", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const orders = Array.from({ length: 20 }, (_, i) => orderN(i + 1, i + 1));
    await run(fakeDeps(fakeOrderSource(orders.slice(0, 16)), wms), client, { limit: 16 });
    // Overlap makes the next search start before the cursor; it must page past handled orders.
    const r = await run(fakeDeps(fakeOrderSource(orders), wms), client);
    expect(r.processed).toBe(4);
    expect(wms.created).toHaveLength(20);
  });

  it("stops before an order it cannot finish within the subrequest budget", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    // 1 search + 4 per order (pre-check, 1 SKU, create, read-back) = 9 for two orders.
    const budget = new SubrequestBudget(8);
    const deps = fakeDeps(fakeOrderSource([orderN(1, 1), orderN(2, 2)]), wms, budget);
    // Fakes don't spend budget, so spend it as the real adapters would.
    for (const k of ["findOrdersByNumber", "lookupProductId", "createOrder", "getOrder"] as const) {
      const orig = wms[k].bind(wms) as (...a: unknown[]) => Promise<unknown>;
      (wms as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => (budget.take(), orig(...a));
    }
    budget.take(); // the search
    const r = await run(deps, client);
    expect(r).toMatchObject({ processed: 1, stoppedBy: "subrequest_budget", cursorTo: "2026-11-15T12:01:00.000Z" });
  });
});

describe("importOrders — guardrails", () => {
  it("halts and deactivates the client if Mintsoft reports a different ClientId after create", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    wms.reportedClientId = 39;
    const err = await run(fakeDeps(fakeOrderSource([wixOrder(), orderN(5, 30)]), wms), client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportHaltedError);
    expect(wms.created).toHaveLength(1); // second order never attempted
    expect((await getClientBySlug(env.DB, "wix-test"))!.active).toBe(false);
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_client_mismatch" }]);
    expect((await rows("SELECT status, mintsoft_order_id FROM order_map"))[0]).toEqual({ status: "held", mintsoft_order_id: 5000 });
  });

  it("sends MINTSOFT_WAREHOUSE_ID on every order", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(wms.created[0]!.WarehouseId).toBe(3);
  });

  it("refuses to run, before any Mintsoft call, when MINTSOFT_WAREHOUSE_ID is not configured", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    const source = fakeOrderSource([wixOrder()]);
    await expect(run({ ...fakeDeps(source, wms), mintsoftWarehouseId: null }, client)).rejects.toThrow(/MINTSOFT_WAREHOUSE_ID/);
    expect(source.calls).toBe(0);
    expect(wms.created).toHaveLength(0);
  });

  it("refuses to run for a client whose Mintsoft ID is not allowlisted", async () => {
    const client = await insertClient({ mintsoftClientId: 39 });
    const wms = fakeWms();
    await expect(run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client)).rejects.toBeInstanceOf(ImportConfigError);
    expect(wms.created).toHaveLength(0);
  });

  it("imports but flags it when the read-back fails", async () => {
    const client = await insertClient();
    const wms = fakeWms();
    wms.getOrder = async () => {
      throw new HttpError({ kind: "http", status: 500, service: "mintsoft", method: "GET", url: "x", attempts: 3 });
    };
    const r = await run(fakeDeps(fakeOrderSource([wixOrder()]), wms), client);
    expect(r.outcomes[0]!.outcome).toBe("imported");
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_verify_failed" }]);
  });
});
