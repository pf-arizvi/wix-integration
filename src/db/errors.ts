/**
 * error_log repository. Codes per SPEC §8 (src/errorCodes.ts).
 * Messages must not contain addresses, emails, phone numbers or keys.
 *
 * TODO(Phase 3): listErrors(unresolved), resolveError(id).
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
