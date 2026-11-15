import { describe, expect, it } from "vitest";
import { createWixApi } from "../../src/adapters/wix/client";
import { buildPaidUnfulfilledSearch, searchPaidUnfulfilledOrders } from "../../src/adapters/wix/orders";
import { createHttpClient } from "../../src/lib/http";

describe("Wix order search", () => {
  it("builds the SPEC §3.1 filter on the first page", () => {
    expect(buildPaidUnfulfilledSearch({ updatedSince: "2026-11-15T11:45:00.000Z", limit: 15 })).toEqual({
      search: {
        filter: {
          paymentStatus: { $eq: "PAID" },
          fulfillmentStatus: { $eq: "NOT_FULFILLED" },
          archived: { $eq: false },
          updatedDate: { $gte: "2026-11-15T11:45:00.000Z" },
        },
        sort: [{ fieldName: "updatedDate", order: "ASC" }],
        cursorPaging: { limit: 15 },
      },
    });
  });

  it("sends only cursor + limit on follow-up pages", () => {
    expect(buildPaidUnfulfilledSearch({ updatedSince: "x", limit: 15, cursor: "abc" })).toEqual({
      search: { cursorPaging: { limit: 15, cursor: "abc" } },
    });
  });

  it("sends site auth headers and parses orders + next cursor", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = createHttpClient({
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        const body = calls.length === 1
          ? { orders: [{ id: "a", number: "1" }], metadata: { hasNext: true, cursors: { next: "n1" } } }
          : { orders: [], metadata: { hasNext: false, cursors: { next: "ignored" } } };
        return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const api = createWixApi(http, { apiKey: "IST.key", siteId: "site-1" });

    const p1 = await searchPaidUnfulfilledOrders(api, { updatedSince: "2026-01-01T00:00:00Z", limit: 15 });
    expect(p1).toEqual({ orders: [{ id: "a", number: "1" }], nextCursor: "n1" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://www.wixapis.com/ecom/v1/orders/search");
    expect(headers.Authorization).toBe("IST.key");
    expect(headers["wix-site-id"]).toBe("site-1");

    const p2 = await searchPaidUnfulfilledOrders(api, { updatedSince: "x", limit: 15, cursor: "n1" });
    expect(p2.nextCursor).toBeNull();
  });
});
