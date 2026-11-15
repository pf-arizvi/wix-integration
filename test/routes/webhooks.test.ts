import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveOrderOutcome } from "../../src/db/orderMap";
import { env } from "cloudflare:workers";
import { insertClient, resetDb, rows, wixOrder } from "../helpers";

const WIX_ID = "3887cf99-35e5-42d9-9be2-e6f98027845e";
const body = {
  ID: 41233,
  ClientId: 38,
  OrderNumber: "10002",
  ExternalOrderReference: WIX_ID,
  TrackingNumber: "AB123456789GB",
  TrackingURL: "https://www.royalmail.com/t/AB123456789GB",
  CourierServiceName: "Royal Mail Tracked 24",
  OrderItems: [{ SKU: "BLKBAGMEDIUM", Quantity: 2 }],
};

const post = (path: string, payload: unknown = body) =>
  exports.default.fetch(new Request(`https://worker.test${path}`, { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) }));

/** Stub Wix only. Any Mintsoft call would be a bug here (payload has items). */
function stubWix() {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const res = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.host === "www.wixapis.com" && url.pathname === `/ecom/v1/orders/${WIX_ID}`) return res({ order: wixOrder() });
    if (url.host === "www.wixapis.com" && url.pathname === `/ecom/v1/fulfillments/orders/${WIX_ID}`) return res({ orderWithFulfillments: { fulfillments: [] } });
    if (url.host === "www.wixapis.com" && url.pathname.endsWith("/create-fulfillment")) return res({ fulfillmentId: "wix-f-1" });
    return res({ message: "unexpected" }, 418);
  });
  return calls;
}

async function seed() {
  const client = await insertClient({ wixApiKeyEnc: await (await import("../../src/lib/crypto")).encryptSecret("IST.key", env.ENCRYPTION_KEY) });
  await saveOrderOutcome(env.DB, { clientId: client.id, wixOrderId: WIX_ID, wixOrderNumber: "10002", status: "imported", mintsoftOrderId: 41233, countAttempt: true });
  return client;
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("despatch webhook auth", () => {
  it.each([
    ["no token", "/webhooks/mintsoft/despatch/wix-test"],
    ["wrong token", "/webhooks/mintsoft/despatch/wix-test?token=nope"],
    ["unknown slug", "/webhooks/mintsoft/despatch/nobody?token=tok_test"],
    ["cancel, wrong token", "/webhooks/mintsoft/cancel/wix-test?token=nope"],
  ])("rejects %s with 401 and does nothing", async (_label, path) => {
    await seed();
    const calls = stubWix();
    expect((await post(path)).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await rows("SELECT * FROM error_log")).toHaveLength(0);
  });
});

describe("despatch webhook", () => {
  it("fulfils the Wix order end-to-end through the real adapters, using the decrypted key", async () => {
    await seed();
    const calls = stubWix();
    const r = await post("/webhooks/mintsoft/despatch/wix-test?token=tok_test");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, processed: true, result: { outcome: "fulfilled", wixOrderNumber: "10002" } });

    const create = calls.find((c) => c.url.pathname.endsWith("/create-fulfillment"))!;
    expect(create.method).toBe("POST");
    expect(create.body).toEqual({
      fulfillment: {
        lineItems: [{ id: "00000000-0000-0000-0000-000000000001", quantity: 2 }],
        trackingInfo: { trackingNumber: "AB123456789GB", shippingProvider: "Royal Mail Tracked 24", trackingLink: "https://www.royalmail.com/t/AB123456789GB" },
      },
    });
    expect(calls.every((c) => c.url.host === "www.wixapis.com")).toBe(true); // nothing sent to Mintsoft
    expect(await rows("SELECT status FROM order_map")).toEqual([{ status: "fulfilled" }]);
    expect(await rows("SELECT * FROM webhook_log")).toHaveLength(0); // DEBUG_PAYLOADS=false
  });

  it("stores the raw payload only when DEBUG_PAYLOADS=true", async () => {
    await seed();
    stubWix();
    const prev = env.DEBUG_PAYLOADS;
    (env as { DEBUG_PAYLOADS: string }).DEBUG_PAYLOADS = "true";
    try {
      await post("/webhooks/mintsoft/despatch/wix-test?token=tok_test");
    } finally {
      (env as { DEBUG_PAYLOADS: string }).DEBUG_PAYLOADS = prev;
    }
    expect(await rows("SELECT source FROM webhook_log")).toEqual([{ source: "mintsoft_despatch" }]);
  });

  it("returns 200 (not a Mintsoft retry storm) for invalid JSON, and records it", async () => {
    await seed();
    stubWix();
    const r = await post("/webhooks/mintsoft/despatch/wix-test?token=tok_test", "not json{");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ processed: false, reason: "invalid_json" });
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "despatch_payload_invalid" }]);
  });

  it("returns 200 but doesn't process for an inactive client", async () => {
    await seed();
    const calls = stubWix();
    await env.DB.prepare("UPDATE clients SET active = 0").run();
    const r = await post("/webhooks/mintsoft/despatch/wix-test?token=tok_test");
    expect(await r.json()).toMatchObject({ processed: false, reason: "client_inactive" });
    expect(calls).toHaveLength(0);
  });

  it("cancel webhook logs for manual follow-up", async () => {
    await seed();
    const calls = stubWix();
    const r = await post("/webhooks/mintsoft/cancel/wix-test?token=tok_test");
    expect(r.status).toBe(200);
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_cancelled" }]);
    expect(calls).toHaveLength(0);
  });
});

describe("webhook_log purge (hourly cron)", () => {
  it("deletes payloads older than 14 days and keeps recent ones", async () => {
    const { purgeWebhookLog } = await import("../../src/db/webhookLog");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO webhook_log (source, payload, created_at) VALUES ('x', 'old', datetime('now', '-15 days'))"),
      env.DB.prepare("INSERT INTO webhook_log (source, payload) VALUES ('x', 'new')"),
    ]);
    expect(await purgeWebhookLog(env.DB)).toBe(1);
    expect(await rows("SELECT payload FROM webhook_log")).toEqual([{ payload: "new" }]);
  });
});
