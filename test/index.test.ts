import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { CRON } from "../src/config";

const fetchWorker = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://worker.test${path}`, init));
const admin = { Authorization: `Bearer ${env.ADMIN_TOKEN}` };

describe("routing", () => {
  it("GET /healthz is public", async () => {
    const res = await fetchWorker("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /admin/health requires the admin token", async () => {
    expect((await fetchWorker("/admin/health")).status).toBe(401);
    expect((await fetchWorker("/admin/health", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("GET /admin/health reports DB status with a valid token", async () => {
    const res = await fetchWorker("/admin/health", { headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: { clients: 0 } });
  });

  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await fetchWorker("/nope")).status).toBe(404);
    expect((await fetchWorker("/healthz", { method: "POST" })).status).toBe(405);
  });
});

describe("scheduled", () => {
  it.each([CRON.IMPORT_ORDERS, CRON.RECONCILE, "1 2 3 4 5"])("dispatches cron %s without throwing", async (cron) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
  });
});

describe("migrations", () => {
  it("creates all tables and indexes (SPEC §5 + 0002 fulfilments)", async () => {
    const { results } = await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ type: string; name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "clients",
      "courier_map",
      "error_log",
      "fulfilments",
      "idx_fulfilments_status",
      "idx_fulfilments_wix_order",
      "idx_order_map_mintsoft",
      "idx_order_map_status",
      "order_map",
      "sync_state",
      "webhook_log",
    ]);
  });

  it("enforces one order_map row per (client, wix order)", async () => {
    await env.DB.prepare(
      "INSERT INTO clients (slug, name, mintsoft_client_id, wix_site_id, wix_api_key_enc, webhook_token) VALUES ('c', 'C', 1, 's', 'k', 't')",
    ).run();
    const insert = env.DB.prepare(
      "INSERT INTO order_map (client_id, wix_order_id, wix_order_number, status) VALUES (1, 'w1', '10002', 'imported')",
    );
    await insert.run();
    await expect(insert.run()).rejects.toThrow(/UNIQUE/);
  });
});
