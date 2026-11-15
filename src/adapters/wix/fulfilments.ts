/**
 * Wix eCom order fulfilments.
 *   listFulfilments   GET  /ecom/v1/fulfillments/orders/{orderId}
 *   createFulfilment  POST /ecom/v1/fulfillments/orders/{orderId}/create-fulfillment
 * https://dev.wix.com/docs/api-reference/business-solutions/e-commerce/orders/order-fulfillments
 *
 * - lineItems (with Wix line item ids) are required; omitted quantity = remaining unfulfilled.
 * - trackingNumber + shippingProvider are required together. UK carriers aren't Wix
 *   predefined providers, so pass the name and our own trackingLink.
 * - 409 ALREADY_EXISTS / TRACKING_NUMBER_ALREADY_EXISTS = already done → success.
 * - May trigger Wix's shipping email to the buyer (site settings).
 */
import { HttpError } from "../../lib/http";
import type { WixApi } from "./client";
import type { WixCreateFulfillmentRequest, WixFulfillment, WixOrderWithFulfillments } from "./types";

export async function listFulfilments(api: WixApi, wixOrderId: string): Promise<WixFulfillment[]> {
  const res = await api.request<WixOrderWithFulfillments | undefined>(
    "GET",
    `/ecom/v1/fulfillments/orders/${encodeURIComponent(wixOrderId)}`,
    undefined,
    { idempotent: true },
  );
  return res?.orderWithFulfillments?.fulfillments ?? [];
}

export type CreateFulfilmentResult = { status: "created"; fulfillmentId: string | null } | { status: "already_exists" };

export async function createFulfilment(api: WixApi, wixOrderId: string, req: WixCreateFulfillmentRequest): Promise<CreateFulfilmentResult> {
  try {
    const res = await api.request<WixOrderWithFulfillments | undefined>(
      "POST",
      `/ecom/v1/fulfillments/orders/${encodeURIComponent(wixOrderId)}/create-fulfillment`,
      req,
      // A create; only 429 is retried. A lost response is caught next time by the
      // fulfilments table, the remaining-quantity check and Wix's duplicate-tracking 409.
      { idempotent: false },
    );
    return { status: "created", fulfillmentId: res?.fulfillmentId ?? null };
  } catch (err) {
    if (isTrackingAlreadyExists(err)) return { status: "already_exists" };
    throw err;
  }
}

export function isTrackingAlreadyExists(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const body = JSON.stringify(err.body ?? err.bodySnippet ?? "");
  return /TRACKING_NUMBER_ALREADY_EXISTS|ALREADY_EXISTS/.test(body);
}
