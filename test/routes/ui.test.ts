import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { CRON } from "../../src/config";
import { insertClient, resetDb, rows } from "../helpers";

const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.ADMIN_TOKEN}`);
  return exports.default.fetch(new Request(`https://worker.test${path}`, { ...init, headers }));
};
const setMaster = (v: string) => ((env as { MINTSOFT_WRITES_ENABLED: string }).MINTSOFT_WRITES_ENABLED = v);

beforeEach(resetDb);
afterEach(() => {
  setMaster("false");
  vi.restoreAllMocks();
});

describe("admin page assets", () => {
  it("serves the page with a strict CSP and no data in it", async () => {
    const r = await exports.default.fetch(new Request("https://worker.test/admin"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    const csp = r.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await r.text();
    expect(html).toContain('<script src="/admin/app.js" defer></script>');
    expect(html).not.toMatch(/<script>(?!<)/); // no inline script
  });

  it("serves app.js and app.css", async () => {
    const js = await exports.default.fetch(new Request("https://worker.test/admin/app.js"));
    expect(js.headers.get("Content-Type")).toContain("javascript");
    const body = await js.text();
    expect(body).not.toContain("innerHTML");
    expect(body).toContain('"X-Admin-UI": "1"');
    expect((await exports.default.fetch(new Request("https://worker.test/admin/app.css"))).headers.get("Content-Type")).toContain("text/css");
  });
});

describe("writes toggle (UI) under the deploy master", () => {
  it("refuses to switch on while the master is off", async () => {
    setMaster("false");
    const r = await call("/admin/settings/writes", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(r.status).toBe(409);
    expect(await rows("SELECT * FROM settings")).toHaveLength(0);
  });

  it("switches on and off with the master on, audits who did it, and state reflects it", async () => {
    setMaster("true");
    let st = (await (await call("/admin/state")).json()) as { writes: { master: boolean; toggle: boolean; effective: boolean } };
    expect(st.writes).toMatchObject({ master: true, toggle: false, effective: false }); // off by default

    const on = await call("/admin/settings/writes", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    st = (await (await call("/admin/state")).json()) as typeof st;
    expect(st.writes).toMatchObject({ toggle: true, effective: true, updatedBy: "admin-token" });

    await call("/admin/settings/writes", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect((await rows<{ action: string; actor: string }>("SELECT action, actor FROM audit_log ORDER BY id")).map((a) => a.action)).toEqual(["writes.on", "writes.off"]);
  });

  it("the master off overrides a toggle left on", async () => {
    setMaster("true");
    await call("/admin/settings/writes", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    setMaster("false");
    const st = (await (await call("/admin/state")).json()) as { writes: { toggle: boolean; effective: boolean } };
    expect(st.writes).toMatchObject({ toggle: true, effective: false });
  });

  it("the import cron does nothing while the page toggle is off, even with the master on", async () => {
    setMaster("true");
    await insertClient();
    const spy = vi.spyOn(globalThis, "fetch");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: CRON.IMPORT_ORDERS, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).not.toHaveBeenCalled();
    const run = (await rows<{ value: string }>("SELECT value FROM settings WHERE key = 'last_run:importOrders'"))[0]!;
    expect(JSON.parse(run.value)).toMatchObject({ ok: true, skipped: "writes are paused in the admin page" });
  });
});

describe("admin data endpoints for the page", () => {
  it("state lists clients with order counts and no secrets", async () => {
    const c = await insertClient();
    await env.DB.prepare("INSERT INTO order_map (client_id, wix_order_id, wix_order_number, status) VALUES (?1, 'a', '1', 'held'), (?1, 'b', '2', 'imported')").bind(c.id).run();
    const body = await (await call("/admin/state")).text();
    expect(body).not.toContain("wixApiKeyEnc");
    expect(body).not.toContain("tok_test");
    const st = JSON.parse(body) as { clients: { orderCounts: Record<string, number> }[]; allowedClientIds: number[]; warehouseId: number };
    expect(st.clients[0]!.orderCounts).toEqual({ held: 1, imported: 1 });
    expect(st).toMatchObject({ allowedClientIds: [38], warehouseId: 3 });
  });

  it("lists orders by status and validates the filter", async () => {
    const c = await insertClient();
    await env.DB.prepare("INSERT INTO order_map (client_id, wix_order_id, wix_order_number, status, last_error) VALUES (?1, 'a', '10005', 'held', 'Order 10005 held: SKU REDHOOD not found in Mintsoft client 38')").bind(c.id).run();
    const r = (await (await call("/admin/clients/wix-test/orders?status=held")).json()) as { orders: { wixOrderNumber: string; lastError: string }[] };
    expect(r.orders).toEqual([expect.objectContaining({ wixOrderNumber: "10005", lastError: expect.stringContaining("REDHOOD") })]);
    expect((await call("/admin/clients/wix-test/orders?status=bogus")).status).toBe(400);
  });
});
