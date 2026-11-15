import { describe, expect, it } from "vitest";
import { createMintsoftApi, MintsoftWriteBlockedError } from "../../src/adapters/mintsoft/client";
import { findClientById } from "../../src/adapters/mintsoft/clients";
import { createOrder, findOrdersByNumber } from "../../src/adapters/mintsoft/orders";
import { lookupProductId } from "../../src/adapters/mintsoft/products";
import type { MintsoftNewOrder } from "../../src/adapters/mintsoft/types";
import { allowedMintsoftClientIds, mintsoftWritesEnabled } from "../../src/config";
import { createHttpClient } from "../../src/lib/http";

function setup(responses: (Response | ((url: string) => Response))[], cfg: { writesEnabled?: boolean; allowed?: number[] } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = createHttpClient({
    sleep: async () => {},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      const r = responses.shift();
      if (!r) throw new Error("no more responses");
      return typeof r === "function" ? r(String(input)) : r;
    }) as typeof fetch,
  });
  const api = createMintsoftApi(http, {
    apiKey: "ms-key",
    writesEnabled: cfg.writesEnabled ?? true,
    allowedClientIds: new Set(cfg.allowed ?? [38]),
  });
  return { api, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const order = (clientId: unknown): MintsoftNewOrder => ({ ClientId: clientId as number, OrderNumber: "10002", OrderItems: [{ SKU: "A", Quantity: 1 }] });

describe("Mintsoft write guardrails", () => {
  it("refuses every write when MINTSOFT_WRITES_ENABLED is off — no request is sent", async () => {
    const { api, calls } = setup([json([{ Success: true, OrderId: 1 }])], { writesEnabled: false });
    await expect(createOrder(api, order(38))).rejects.toMatchObject({ name: "MintsoftWriteBlockedError", code: "mintsoft_writes_disabled" });
    expect(calls).toHaveLength(0);
  });

  it.each([39, 0, -38, 38.5, "38", null, undefined])("refuses ClientId %j when only 38 is allowed — no request is sent", async (clientId) => {
    const { api, calls } = setup([json([{ Success: true, OrderId: 1 }])]);
    const err = await createOrder(api, order(clientId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MintsoftWriteBlockedError);
    expect((err as MintsoftWriteBlockedError).code).toBe("mintsoft_client_not_allowed");
    expect(calls).toHaveLength(0);
  });

  it("sends an allowed create as PUT /api/Order with ms-apikey, not retried on 5xx", async () => {
    const { api, calls } = setup([json([{ Success: true, OrderId: 123, OrderNumber: "10002" }])]);
    const res = await createOrder(api, order(38));
    expect(res).toMatchObject({ Success: true, OrderId: 123 });
    expect(calls[0]!.url).toBe("https://api.mintsoft.co.uk/api/Order");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>)["ms-apikey"]).toBe("ms-key");
    expect(JSON.parse(calls[0]!.init.body as string).ClientId).toBe(38);

    const again = setup([json({}, 503), json([{ Success: true, OrderId: 1 }])]);
    await expect(createOrder(again.api, order(38))).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(again.calls).toHaveLength(1);
  });

  it("refuses to construct without an API key", () => {
    expect(() => createMintsoftApi(createHttpClient(), { apiKey: "", writesEnabled: true, allowedClientIds: new Set([38]) })).toThrow(/MINTSOFT_API_KEY/);
  });
});

describe("guardrail config parsing", () => {
  it("only the exact string 'true' enables writes", () => {
    expect(mintsoftWritesEnabled({ MINTSOFT_WRITES_ENABLED: "true" })).toBe(true);
    for (const v of ["TRUE", "1", "yes", "", " true", "false"]) expect(mintsoftWritesEnabled({ MINTSOFT_WRITES_ENABLED: v })).toBe(false);
  });
  it("drops invalid allowlist entries rather than widening access", () => {
    expect([...allowedMintsoftClientIds({ MINTSOFT_ALLOWED_CLIENT_IDS: " 38, 40 ,abc,-1,0,4.5,*" })]).toEqual([38, 40]);
    expect(allowedMintsoftClientIds({ MINTSOFT_ALLOWED_CLIENT_IDS: "" }).size).toBe(0);
  });
});

describe("Mintsoft reads", () => {
  it("findOrdersByNumber uses exact search and filters to the client", async () => {
    const { api, calls } = setup([
      json([
        { ID: 1, ClientId: 99, OrderNumber: "10002" },
        { ID: 2, ClientId: 38, OrderNumber: "10002" },
        { ID: 3, ClientId: 38, OrderNumber: "100021" },
      ]),
    ]);
    expect((await findOrdersByNumber(api, "10002", 38)).map((o) => o.ID)).toEqual([2]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/Order/Search");
    expect(url.searchParams.get("OrderNumber")).toBe("10002");
    expect(url.searchParams.get("exactMatch")).toBe("true");
    expect(url.searchParams.has("includeOrderItems")).toBe(false);
  });

  it("lookupProductId treats 0 / 404 as missing and propagates other errors", async () => {
    const { api, calls } = setup([json(4567), json(0), json({}, 404), json({}, 400)]);
    expect(await lookupProductId(api, "BLKBAGMEDIUM", 38)).toBe(4567);
    expect(new URL(calls[0]!.url).searchParams.get("ClientId")).toBe("38");
    expect(await lookupProductId(api, "NOPE", 38)).toBeNull();
    expect(await lookupProductId(api, "NOPE", 38)).toBeNull();
    await expect(lookupProductId(api, "X", 38)).rejects.toMatchObject({ status: 400 });
  });

  it("findClientById pages through GET /api/Client", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ID: i + 1, Name: `C${i + 1}` }));
    const { api, calls } = setup([json(page1), json([{ ID: 138, Name: "Late" }])]);
    expect(await findClientById(api, 138)).toEqual({ ID: 138, Name: "Late" });
    expect(calls.map((c) => new URL(c.url).searchParams.get("pageNo"))).toEqual(["1", "2"]);
  });
});
