import { describe, expect, it } from "vitest";
import { buildQueryVariantsBody, getCatalogVersion, queryVariantsV3 } from "../../src/adapters/wix/catalog";
import { createWixApi } from "../../src/adapters/wix/client";
import { createHttpClient } from "../../src/lib/http";

function api(bodies: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = createHttpClient({
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(bodies.shift()), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  return { wix: createWixApi(http, { apiKey: "k", siteId: "s" }), calls };
}

describe("Wix catalog adapter", () => {
  it.each([
    ["V3_CATALOG", "V3"],
    ["V1_CATALOG", "V1"],
    ["STORES_NOT_INSTALLED", "NOT_INSTALLED"],
    ["SOMETHING_NEW", "UNKNOWN"],
  ])("maps catalog version %s → %s", async (raw, expected) => {
    const { wix, calls } = api([{ catalogVersion: raw }]);
    expect(await getCatalogVersion(wix)).toBe(expected);
    expect(calls[0]!.url).toBe("https://www.wixapis.com/stores/v3/provision/version");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("asks for weights on every page and sends only the cursor on follow-ups", () => {
    expect(buildQueryVariantsBody({ limit: 12 })).toEqual({
      fields: ["WEIGHT_MEASUREMENT_UNIT_INFO"],
      query: { cursorPaging: { limit: 12 }, sort: [{ fieldName: "productData.productId", order: "ASC" }] },
    });
    expect(buildQueryVariantsBody({ limit: 12, cursor: "c1" })).toEqual({
      fields: ["WEIGHT_MEASUREMENT_UNIT_INFO"],
      query: { cursorPaging: { limit: 12, cursor: "c1" } },
    });
  });

  it("parses variants and the next cursor", async () => {
    const { wix, calls } = api([
      { variants: [{ sku: "A" }], pagingMetadata: { hasNext: true, cursors: { next: "c2" } } },
      { variants: [], pagingMetadata: { hasNext: false } },
    ]);
    expect(await queryVariantsV3(wix, { limit: 12 })).toEqual({ variants: [{ sku: "A" }], nextCursor: "c2" });
    expect(calls[0]!.url).toBe("https://www.wixapis.com/stores/v3/products/query-variants");
    expect((await queryVariantsV3(wix, { limit: 12, cursor: "c2" })).nextCursor).toBeNull();
  });
});
