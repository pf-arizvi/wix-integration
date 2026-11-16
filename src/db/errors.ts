/**
 * error_log repository. Codes per SPEC §8 (src/errorCodes.ts).
 * Messages must not contain addresses, emails, phone numbers or keys.
 */
import type { ErrorCode } from "../errorCodes";

export type Flow = "importOrders" | "pushTracking" | "reconcile" | "importProducts" | "admin";

export interface NewError {
  clientId: number | null;
  flow: Flow;
  ref: string | null;
  code: ErrorCode;
  message: string;
}

export function recordErrorStatement(db: D1Database, e: NewError): D1PreparedStatement {
  return db
    .prepare("INSERT INTO error_log (client_id, flow, ref, code, message) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(e.clientId, e.flow, e.ref, e.code, e.message.slice(0, 2000));
}

export async function recordError(db: D1Database, e: NewError): Promise<void> {
  await recordErrorStatement(db, e).run();
}

export interface ErrorRecord {
  id: number;
  clientId: number | null;
  flow: string;
  ref: string | null;
  code: string;
  message: string;
  resolved: boolean;
  createdAt: string;
}

export async function listErrors(db: D1Database, opts: { unresolvedOnly: boolean; limit: number }): Promise<ErrorRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM error_log ${opts.unresolvedOnly ? "WHERE resolved = 0" : ""} ORDER BY id DESC LIMIT ?1`)
    .bind(opts.limit)
    .all<{ id: number; client_id: number | null; flow: string; ref: string | null; code: string; message: string; resolved: number; created_at: string }>();
  return results.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    flow: r.flow,
    ref: r.ref,
    code: r.code,
    message: r.message,
    resolved: r.resolved === 1,
    createdAt: r.created_at,
  }));
}

/** Marks one error resolved. Returns false if it doesn't exist. */
export async function resolveError(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE error_log SET resolved = 1 WHERE id = ?1").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
