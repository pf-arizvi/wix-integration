/**
 * Mintsoft orders.
 *   createOrder        PUT /api/Order (body NewOrderWithItems, includes ConnectAction)
 *   getOrder           GET /api/Order/{id}
 *   findOrdersByNumber GET /api/Order/Search?OrderNumber=&exactMatch=true, ClientId filtered here
 * Never pass IncludeOrderItems=true (causes 400s).
 *
 *   listDespatchedSince GET /api/Order/List?SinceDespatchDate=&SortOldestFirst=true (100/page)
 */
import type { MintsoftApi } from "./client";
import type { MintsoftNewOrder, MintsoftNewOrderResult, MintsoftOrder, MintsoftOrderItem } from "./types";

export async function createOrder(api: MintsoftApi, order: MintsoftNewOrder): Promise<MintsoftNewOrderResult> {
  // Guarded write: ClientId from the body itself is what gets checked.
  const res = await api.write<MintsoftNewOrderResult[] | MintsoftNewOrderResult | undefined>("PUT", "/api/Order", order, order.ClientId);
  const first = Array.isArray(res) ? res[0] : res;
  return first ?? { Success: false, Message: "Empty response from PUT /api/Order" };
}

export async function getOrder(api: MintsoftApi, id: number): Promise<MintsoftOrder> {
  return api.get<MintsoftOrder>(`/api/Order/${encodeURIComponent(String(id))}`);
}

/** GET /api/Order/{id}/Items — the items of one Mintsoft order (a split part has only its own items). */
export async function getOrderItems(api: MintsoftApi, id: number): Promise<MintsoftOrderItem[]> {
  const res = await api.get<MintsoftOrderItem[] | undefined>(`/api/Order/${encodeURIComponent(String(id))}/Items`);
  return Array.isArray(res) ? res : [];
}

/**
 * Exact order-number search, filtered to `clientId` client-side (warehouse-level
 * keys may return other clients' orders with the same number).
 */
export async function findOrdersByNumber(api: MintsoftApi, orderNumber: string, clientId: number): Promise<MintsoftOrder[]> {
  const res = await api.get<MintsoftOrder[] | undefined>("/api/Order/Search", { OrderNumber: orderNumber, exactMatch: true });
  return (Array.isArray(res) ? res : []).filter((o) => o.ClientId === clientId && o.OrderNumber === orderNumber);
}

/** Order/List hard cap. */
export const ORDER_LIST_PAGE_SIZE = 100;

/**
 * Orders despatched since `since`, oldest first, ALL clients (the ClientId filter is ignored
 * on warehouse-level keys — callers filter client-side). Never sends IncludeOrderItems (400s).
 * VERIFY: SinceDespatchDate format/timezone; sent as "YYYY-MM-DDTHH:mm:ss" (no zone), with a
 * 2h overlap on the caller side to absorb UK time vs UTC.
 */
export async function listDespatchedSince(api: MintsoftApi, since: string, pageNo: number): Promise<MintsoftOrder[]> {
  const res = await api.get<MintsoftOrder[] | undefined>("/api/Order/List", {
    SinceDespatchDate: since,
    SortOldestFirst: true,
    PageNo: pageNo,
    Limit: ORDER_LIST_PAGE_SIZE,
  });
  return Array.isArray(res) ? res : [];
}
