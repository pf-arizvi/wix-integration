/**
 * order_map repository (SPEC §5). One row per (client_id, wix_order_id).
 */
import { type NewError, recordErrorStatement } from "./errors";

export type OrderStatus = "imported" | "held" | "skipped_non_physical" | "despatched" | "fulfilled" | "fulfil_failed";

export interface OrderMapRecord {
  id: number;
  clientId: number;
  wixOrderId: string;
  wixOrderNumber: string;
  mintsoftOrderId: number | null;
  status: OrderStatus;
  trackingNumber: string | null;
  lastError: string | null;
  attempts: number;
}

interface Row {
  id: number;
  client_id: number;
  wix_order_id: string;
  wix_order_number: string;
  mintsoft_order_id: number | null;
  status: OrderStatus;
  tracking_number: string | null;
  last_error: string | null;
  attempts: number;
}

const toRecord = (r: Row): OrderMapRecord => ({
  id: r.id,
  clientId: r.client_id,
  wixOrderId: r.wix_order_id,
  wixOrderNumber: r.wix_order_number,
  mintsoftOrderId: r.mintsoft_order_id,
  status: r.status,
  trackingNumber: r.tracking_number,
  lastError: r.last_error,
  attempts: r.attempts,
});

/** D1 allows 100 bound parameters per statement. */
const MAX_IDS_PER_QUERY = 90;

/** One query per page of orders (not per order) to stay within D1 per-invocation limits. */
export async function getOrderMapsByWixIds(db: D1Database, clientId: number, wixOrderIds: readonly string[]): Promise<Map<string, OrderMapRecord>> {
  const out = new Map<string, OrderMapRecord>();
  for (let i = 0; i < wixOrderIds.length; i += MAX_IDS_PER_QUERY) {
    const chunk = wixOrderIds.slice(i, i + MAX_IDS_PER_QUERY);
    const placeholders = chunk.map((_, j) => `?${j + 2}`).join(", ");
    const { results } = await db
      .prepare(`SELECT * FROM order_map WHERE client_id = ?1 AND wix_order_id IN (${placeholders})`)
      .bind(clientId, ...chunk)
      .all<Row>();
    for (const r of results) out.set(r.wix_order_id, toRecord(r));
  }
  return out;
}

export async function getOrderMapByWixNumber(db: D1Database, clientId: number, wixOrderNumber: string): Promise<OrderMapRecord | null> {
  const row = await db
    .prepare("SELECT * FROM order_map WHERE client_id = ?1 AND wix_order_number = ?2")
    .bind(clientId, wixOrderNumber)
    .first<Row>();
  return row ? toRecord(row) : null;
}

export interface OrderOutcomeWrite {
  clientId: number;
  wixOrderId: string;
  wixOrderNumber: string;
  status: OrderStatus;
  mintsoftOrderId?: number | null;
  lastError?: string | null;
  /** Count this as an import attempt (attempts += 1). */
  countAttempt: boolean;
  /** Optional error_log row written in the same batch. */
  error?: NewError;
}

/** Upserts the order_map row (+ optional error_log row) atomically in one D1 batch. */
export async function saveOrderOutcome(db: D1Database, o: OrderOutcomeWrite): Promise<void> {
  const upsert = db
    .prepare(
      `INSERT INTO order_map (client_id, wix_order_id, wix_order_number, mintsoft_order_id, status, last_error, attempts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (client_id, wix_order_id) DO UPDATE SET
         wix_order_number  = excluded.wix_order_number,
         mintsoft_order_id = COALESCE(excluded.mintsoft_order_id, order_map.mintsoft_order_id),
         status            = excluded.status,
         last_error        = excluded.last_error,
         attempts          = order_map.attempts + excluded.attempts,
         updated_at        = datetime('now')`,
    )
    .bind(
      o.clientId,
      o.wixOrderId,
      o.wixOrderNumber,
      o.mintsoftOrderId ?? null,
      o.status,
      o.lastError ?? null,
      o.countAttempt ? 1 : 0,
    );
  await db.batch(o.error ? [upsert, recordErrorStatement(db, o.error)] : [upsert]);
}
