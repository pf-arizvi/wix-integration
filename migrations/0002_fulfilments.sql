-- One row per Mintsoft order despatched (a split order's parts each have their own Mintsoft order ID).
-- Idempotency for the despatch webhook: a part already fulfilled in Wix is never fulfilled again.
CREATE TABLE fulfilments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER NOT NULL REFERENCES clients(id),
  wix_order_id          TEXT NOT NULL,
  mintsoft_order_id     INTEGER NOT NULL,
  tracking_number       TEXT,
  wix_fulfillment_id    TEXT,
  status                TEXT NOT NULL,                 -- 'created' | 'failed'
  last_error            TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, mintsoft_order_id)
);
CREATE INDEX idx_fulfilments_wix_order ON fulfilments(client_id, wix_order_id);
CREATE INDEX idx_fulfilments_status ON fulfilments(status);
