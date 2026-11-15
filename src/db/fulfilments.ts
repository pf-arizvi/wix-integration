/**
 * fulfilments repository (migration 0002). One row per despatched Mintsoft order
 * (each split part has its own Mintsoft order ID). Idempotency for the despatch webhook.
 */
import { type NewError, recordErrorStatement } from "./errors";
import type { OrderStatus } from "./orderMap";

export interface FulfilmentRecord {
  clientId: number;
  wixOrderId: string;
  mintsoftOrderId: number;
  trackingNumber: string | null;
  wixFulfillmentId: string | null;
  status: "created" | "failed";
  lastError: string | null;
  attempts: number;
}

interface Row {
  client_id: number;
  wix_order_id: string;
  mintsoft_order_id: number;
  tracking_number: string | null;
  wix_fulfillment_id: string | null;
  status: "created" | "failed";
  last_error: string | null;
  attempts: number;
}

export async function getFulfilment(db: D1Database, clientId: number, mintsoftOrderId: number): Promise<FulfilmentRecord | null> {
  const r = await db
    .prepare("SELECT * FROM fulfilments WHERE client_id = ?1 AND mintsoft_order_id = ?2")
    .bind(clientId, mintsoftOrderId)
    .first<Row>();
  return r
    ? {
        clientId: r.client_id,
        wixOrderId: r.wix_order_id,
        mintsoftOrderId: r.mintsoft_order_id,
        trackingNumber: r.tracking_number,
        wixFulfillmentId: r.wix_fulfillment_id,
        status: r.status,
        lastError: r.last_error,
        attempts: r.attempts,
      }
    : null;
}

export interface FulfilmentOutcomeWrite {
  clientId: number;
  wixOrderId: string;
  mintsoftOrderId: number;
  trackingNumber: string | null;
  wixFulfillmentId: string | null;
  status: "created" | "failed";
  lastError: string | null;
  /** New order_map status for the Wix order. */
  orderStatus: OrderStatus;
  error?: NewError;
}

/** Upserts the fulfilments row, updates order_map, and optionally logs an error — one D1 batch. */
export async function saveFulfilmentOutcome(db: D1Database, o: FulfilmentOutcomeWrite): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO fulfilments (client_id, wix_order_id, mintsoft_order_id, tracking_number, wix_fulfillment_id, status, last_error, attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT (client_id, mintsoft_order_id) DO UPDATE SET
           tracking_number    = COALESCE(excluded.tracking_number, fulfilments.tracking_number),
           wix_fulfillment_id = COALESCE(excluded.wix_fulfillment_id, fulfilments.wix_fulfillment_id),
           status             = excluded.status,
           last_error         = excluded.last_error,
           attempts           = fulfilments.attempts + 1,
           updated_at         = datetime('now')`,
      )
      .bind(o.clientId, o.wixOrderId, o.mintsoftOrderId, o.trackingNumber, o.wixFulfillmentId, o.status, o.lastError),
    db
      .prepare(
        `UPDATE order_map SET status = ?3,
           tracking_number = COALESCE(?4, tracking_number),
           last_error = ?5,
           updated_at = datetime('now')
         WHERE client_id = ?1 AND wix_order_id = ?2`,
      )
      .bind(o.clientId, o.wixOrderId, o.orderStatus, o.trackingNumber, o.lastError),
  ];
  if (o.error) stmts.push(recordErrorStatement(db, o.error));
  await db.batch(stmts);
}

/** Failed fulfilments still under the retry limit, oldest first. */
export async function listRetryableFulfilments(db: D1Database, maxAttempts: number, limit: number): Promise<FulfilmentRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM fulfilments WHERE status = 'failed' AND attempts < ?1 ORDER BY updated_at LIMIT ?2")
    .bind(maxAttempts, limit)
    .all<Row>();
  return results.map((r) => ({
    clientId: r.client_id,
    wixOrderId: r.wix_order_id,
    mintsoftOrderId: r.mintsoft_order_id,
    trackingNumber: r.tracking_number,
    wixFulfillmentId: r.wix_fulfillment_id,
    status: r.status,
    lastError: r.last_error,
    attempts: r.attempts,
  }));
}
