/**
 * Wix Stores catalog.
 *   getCatalogVersion  GET  /stores/v3/provision/version
 *   queryVariantsV3    POST /stores/v3/products/query-variants (Catalog V3, ≤ 1000/page)
 *
 * TODO: Catalog V1 (POST /stores/v1/products/query, variants nested in products) —
 * not built until a V1 test site is available. V1 sites are refused with a clear error.
 */
import type { WixApi } from "./client";
import type { WixCatalogVersionResponse, WixQueryVariantsResponse, WixReadOnlyVariant } from "./types";

export type CatalogVersion = "V1" | "V3" | "NOT_INSTALLED" | "UNKNOWN";

export async function getCatalogVersion(api: WixApi): Promise<CatalogVersion> {
  const res = await api.request<WixCatalogVersionResponse | undefined>("GET", "/stores/v3/provision/version", undefined, { idempotent: true });
  switch (res?.catalogVersion) {
    case "V1_CATALOG":
      return "V1";
    case "V3_CATALOG":
      return "V3";
    case "STORES_NOT_INSTALLED":
      return "NOT_INSTALLED";
    default:
      return "UNKNOWN";
  }
}

export interface VariantsPage {
  variants: WixReadOnlyVariant[];
  nextCursor: string | null;
}

export function buildQueryVariantsBody(opts: { limit: number; cursor?: string | null }): unknown {
  // Weight is only returned with WEIGHT_MEASUREMENT_UNIT_INFO. `fields` is not part of
  // `query`, so it is sent on every page; follow-up pages send cursor, not sort.
  return {
    fields: ["WEIGHT_MEASUREMENT_UNIT_INFO"],
    query: opts.cursor
      ? { cursorPaging: { limit: opts.limit, cursor: opts.cursor } }
      : { cursorPaging: { limit: opts.limit }, sort: [{ fieldName: "productData.productId", order: "ASC" }] },
  };
}

export async function queryVariantsV3(api: WixApi, opts: { limit: number; cursor?: string | null }): Promise<VariantsPage> {
  const res = await api.request<WixQueryVariantsResponse | undefined>(
    "POST",
    "/stores/v3/products/query-variants",
    buildQueryVariantsBody(opts),
    { idempotent: true },
  );
  const meta = res?.pagingMetadata;
  return {
    variants: Array.isArray(res?.variants) ? res.variants : [],
    nextCursor: meta?.hasNext === false ? null : meta?.cursors?.next || null,
  };
}
