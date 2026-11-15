/**
 * sync_state repository: per-client cursors.
 */

export type SyncKey = "orders_cursor" | "reconcile_since";

export async function getSyncState(db: D1Database, clientId: number, key: SyncKey): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM sync_state WHERE client_id = ?1 AND key = ?2")
    .bind(clientId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSyncState(db: D1Database, clientId: number, key: SyncKey, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (client_id, key, value) VALUES (?1, ?2, ?3)
       ON CONFLICT (client_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(clientId, key, value)
    .run();
}
