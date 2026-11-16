/**
 * settings + audit_log repositories (migration 0005).
 */

export interface Setting {
  value: string;
  updatedBy: string | null;
  updatedAt: string;
}

export type SettingKey = "mintsoft_writes" | `last_run:${string}`;

export async function getSetting(db: D1Database, key: SettingKey): Promise<Setting | null> {
  const r = await db
    .prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string; updated_by: string | null; updated_at: string }>();
  return r ? { value: r.value, updatedBy: r.updated_by, updatedAt: r.updated_at } : null;
}

export async function listSettings(db: D1Database, prefix: string): Promise<Record<string, Setting>> {
  const { results } = await db
    .prepare("SELECT key, value, updated_by, updated_at FROM settings WHERE key LIKE ?1")
    .bind(`${prefix}%`)
    .all<{ key: string; value: string; updated_by: string | null; updated_at: string }>();
  return Object.fromEntries(results.map((r) => [r.key, { value: r.value, updatedBy: r.updated_by, updatedAt: r.updated_at }]));
}

export function setSettingStatement(db: D1Database, key: SettingKey, value: string, by: string | null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    )
    .bind(key, value, by);
}

export async function setSetting(db: D1Database, key: SettingKey, value: string, by: string | null): Promise<void> {
  await setSettingStatement(db, key, value, by).run();
}

/** The admin-page writes toggle. Absent = off. */
export async function writesToggleOn(db: D1Database): Promise<boolean> {
  return (await getSetting(db, "mintsoft_writes"))?.value === "on";
}

export function auditStatement(db: D1Database, actor: string, action: string, detail?: string | null): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (actor, action, detail) VALUES (?1, ?2, ?3)")
    .bind(actor, action, detail ? detail.slice(0, 1000) : null);
}

export async function audit(db: D1Database, actor: string, action: string, detail?: string | null): Promise<void> {
  await auditStatement(db, actor, action, detail).run();
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

export async function listAudit(db: D1Database, limit: number): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1")
    .bind(limit)
    .all<{ id: number; actor: string; action: string; detail: string | null; created_at: string }>();
  return results.map((r) => ({ id: r.id, actor: r.actor, action: r.action, detail: r.detail, createdAt: r.created_at }));
}
