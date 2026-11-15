/**
 * Wix eCom orders.
 * Search: POST /ecom/v1/orders/search (cursor paging, limit ≤ 100).
 * https://dev.wix.com/docs/rest/business-solutions/e-commerce/orders/search-orders
 */
import type { WixApi } from "./client";
import type { WixOrder, WixSearchOrdersResponse } from "./types";

export interface OrdersPage {
  orders: WixOrder[];
  /** Cursor for the next page, or null when there are no more. */
  nextCursor: string | null;
}

export interface SearchPaidUnfulfilledOptions {
  /** ISO timestamp; orders with updatedDate >= this. */
  updatedSince: string;
  limit: number;
  /** Continue a previous search. Wix only needs cursor + limit on follow-up pages. */
  cursor?: string | null;
}

/** Paid, not fulfilled, not archived orders, oldest update first (SPEC §3.1 — confirmed on dev site). */
export function buildPaidUnfulfilledSearch(opts: SearchPaidUnfulfilledOptions): unknown {
  if (opts.cursor) {
    return { search: { cursorPaging: { limit: opts.limit, cursor: opts.cursor } } };
  }
  return {
    search: {
      filter: {
        paymentStatus: { $eq: "PAID" },
        fulfillmentStatus: { $eq: "NOT_FULFILLED" },
        archived: { $eq: false },
        updatedDate: { $gte: opts.updatedSince },
      },
      sort: [{ fieldName: "updatedDate", order: "ASC" }],
      cursorPaging: { limit: opts.limit },
    },
  };
}

/** GET /ecom/v1/orders/{id} → { order }. */
export async function getOrder(api: WixApi, wixOrderId: string): Promise<WixOrder> {
  const res = await api.request<{ order?: WixOrder } | undefined>("GET", `/ecom/v1/orders/${encodeURIComponent(wixOrderId)}`, undefined, {
    idempotent: true,
  });
  if (!res?.order) throw new Error(`Wix GET order ${wixOrderId} returned no order`);
  return res.order;
}

export async function searchPaidUnfulfilledOrders(api: WixApi, opts: SearchPaidUnfulfilledOptions): Promise<OrdersPage> {
  const res = await api.request<WixSearchOrdersResponse | undefined>(
    "POST",
    "/ecom/v1/orders/search",
    buildPaidUnfulfilledSearch(opts),
    { idempotent: true },
  );
  const meta = res?.metadata ?? res?.pagingMetadata;
  const next = meta?.cursors?.next ?? null;
  return {
    orders: Array.isArray(res?.orders) ? res.orders : [],
    nextCursor: meta?.hasNext === false ? null : next || null,
  };
}
