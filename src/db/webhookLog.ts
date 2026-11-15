/**
 * webhook_log repository. Raw payloads contain personal data (addresses), so:
 * written ONLY when DEBUG_PAYLOADS=true, and purged after WEBHOOK_LOG_RETENTION_DAYS.
 */
import { WEBHOOK_LOG_RETENTION_DAYS } from "../config";

const MAX_PAYLOAD_CHARS = 100_000;

export async function logWebhookPayload(db: D1Database, clientId: number | null, source: string, payload: string): Promise<void> {
  await db
    .prepare("INSERT INTO webhook_log (client_id, source, payload) VALUES (?1, ?2, ?3)")
    .bind(clientId, source, payload.slice(0, MAX_PAYLOAD_CHARS))
    .run();
}

/** Deletes rows older than the retention period. Returns rows deleted. */
export async function purgeWebhookLog(db: D1Database, days = WEBHOOK_LOG_RETENTION_DAYS): Promise<number> {
  const res = await db.prepare("DELETE FROM webhook_log WHERE created_at < datetime('now', ?1)").bind(`-${days} days`).run();
  return res.meta.changes ?? 0;
}
