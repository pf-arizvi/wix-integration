import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, rows, wixOrder } from "../helpers";

const call = (path: string, init: RequestInit & { auth?: boolean } = {}) => {
  const { auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) headers.set("Authorization", `Bearer ${env.ADMIN_TOKEN}`);
  return exports.default.fetch(new Request(`https://worker.test${path}`, { ...rest, headers }));
};
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

const createBody = {
  slug: "wix-test",
  name: "Wix Test Client",
  mintsoft_client_id: 38,
  mintsoft_client_name: "Wix Test Client",
  wix_site_id: "site-1",
  wix_api_key: "IST.real-looking-key",
  default_courier_service_id: 7,
  import_orders_since: "2026-11-15T11:00:00Z",
};

/** Stubs outbound fetch (Wix + Mintsoft) and records every call. */
function stubUpstreams() {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  const res = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.host === "www.wixapis.com") return res({ orders: [wixOrder()], metadata: { hasNext: false } });
    if (url.pathname === "/api/Client") return res([{ ID: 38, Name: "Wix Test Client" }]);
    if (url.pathname === "/api/Order/Search") return res([]);
    if (url.pathname === "/api/Product/LookupProductId") return res(4567);
    return res({ message: "unexpected" }, 418);
  });
  return calls;
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("admin auth", () => {
  it.each([
    ["POST", "/admin/clients"],
    ["GET", "/admin/clients"],
    ["PUT", "/admin/clients/x/courier-map"],
    ["POST", "/admin/clients/x/run-import"],
  ])("%s %s requires the admin token", async (method, path) => {
    expect((await call(path, { method, auth: false })).status).toBe(401);
  });
});

describe("POST /admin/clients", () => {
  it("validates input before calling anything", async () => {
    const calls = stubUpstreams();
    const r = await post("/admin/clients", { ...createBody, slug: "Bad Slug" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toMatch(/slug/);
    expect(calls).toHaveLength(0);
  });

  it("onboards end-to-end, never echoing the Wix key, and the dry run writes nothing to Mintsoft", async () => {
    const calls = stubUpstreams();
    const created = await post("/admin/clients", createBody);
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(body).not.toContain("IST.real-looking-key");
    expect(JSON.parse(body)).toMatchObject({ client: { slug: "wix-test", mintsoftClientId: 38 }, mintsoft_client: { id: 38, name: "Wix Test Client" } });

    const listed = await (await call("/admin/clients")).text();
    expect(listed).not.toContain("wixApiKeyEnc");
    expect(listed).not.toContain("webhookToken");

    const dry = await post("/admin/clients/wix-test/run-import?dryRun=false", {});
    expect(dry.status).toBe(200);
    const report = (await dry.json()) as { dryRun: boolean; note: string; outcomes: { outcome: string; payload: { ClientId: number } }[] };
    expect(report.dryRun).toBe(true); // writes are disabled in the test env
    expect(report.note).toMatch(/Forced dry run/);
    expect(report.outcomes[0]).toMatchObject({ outcome: "would_import", payload: { ClientId: 38 } });

    // The decrypted key was used for Wix, and NO write ever reached Mintsoft.
    expect(calls.some((c) => c.url.host === "www.wixapis.com")).toBe(true);
    expect(calls.filter((c) => c.url.host === "api.mintsoft.co.uk" && c.method !== "GET")).toEqual([]);
    expect(await rows("SELECT * FROM order_map")).toHaveLength(0);
  });
});

describe("PUT /admin/clients/:slug/courier-map", () => {
  it("upserts case-insensitively", async () => {
    stubUpstreams();
    await post("/admin/clients", createBody);
    const put = (title: string, id: number) =>
      call("/admin/clients/wix-test/courier-map", {
        method: "PUT",
        body: JSON.stringify({ mappings: [{ wix_shipping_title: title, mintsoft_courier_service_id: id, carrier_display_name: "DPD" }] }),
      });
    expect((await put("Express Shipping", 11)).status).toBe(200);
    const r = await put("  express shipping ", 12);
    expect(((await r.json()) as { mappings: unknown[] }).mappings).toEqual([
      { wixShippingTitle: "express shipping", mintsoftCourierServiceId: 12, carrierDisplayName: "DPD" },
    ]);
  });

  it("404s an unknown client and 400s bad input", async () => {
    expect((await call("/admin/clients/nope/courier-map", { method: "PUT", body: "{}" })).status).toBe(404);
    stubUpstreams();
    await post("/admin/clients", createBody);
    const bad = await call("/admin/clients/wix-test/courier-map", {
      method: "PUT",
      body: JSON.stringify({ mappings: [{ wix_shipping_title: "x", mintsoft_courier_service_id: "11" }] }),
    });
    expect(bad.status).toBe(400);
  });
});
