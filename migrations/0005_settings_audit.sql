-- Runtime settings changed from the admin page (e.g. the Mintsoft writes toggle) and last-run summaries.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who did what from the admin page / admin API.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,                 -- Access email, or 'admin-token'
  action      TEXT NOT NULL,                 -- e.g. 'writes.on', 'orders.import', 'order.retry'
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
