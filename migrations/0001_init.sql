CREATE TABLE clients (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                  TEXT NOT NULL UNIQUE,          -- used in webhook URL
  name                  TEXT NOT NULL,
  mintsoft_client_id    INTEGER NOT NULL,
  wix_site_id           TEXT NOT NULL,
  wix_api_key_enc       TEXT NOT NULL,                 -- AES-GCM ciphertext (base64), iv prefixed
  webhook_token         TEXT NOT NULL,                 -- random, per client
  order_number_prefix   TEXT DEFAULT '',
  default_courier_service_id INTEGER,
  default_carrier_name  TEXT,
  catalog_version       TEXT,                          -- 'V1' | 'V3', detected at onboarding
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE courier_map (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER NOT NULL REFERENCES clients(id),
  wix_shipping_title    TEXT NOT NULL,                 -- matched case-insensitively, trimmed
  mintsoft_courier_service_id INTEGER NOT NULL,
  carrier_display_name  TEXT,                          -- shown to customer in Wix, e.g. 'Royal Mail'
  UNIQUE (client_id, wix_shipping_title)
);

CREATE TABLE order_map (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER NOT NULL REFERENCES clients(id),
  wix_order_id          TEXT NOT NULL,
  wix_order_number      TEXT NOT NULL,
  mintsoft_order_id     INTEGER,
  status                TEXT NOT NULL,                 -- 'imported' | 'held' | 'skipped_non_physical' | 'despatched' | 'fulfilled' | 'fulfil_failed'
  tracking_number       TEXT,
  last_error            TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, wix_order_id)
);
CREATE INDEX idx_order_map_status ON order_map(client_id, status);
CREATE INDEX idx_order_map_mintsoft ON order_map(mintsoft_order_id);

CREATE TABLE sync_state (
  client_id             INTEGER NOT NULL REFERENCES clients(id),
  key                   TEXT NOT NULL,                 -- 'orders_cursor' | 'reconcile_since'
  value                 TEXT NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, key)
);

CREATE TABLE error_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER,
  flow                  TEXT NOT NULL,                 -- 'importOrders' | 'pushTracking' | 'reconcile' | 'importProducts'
  ref                   TEXT,                          -- wix order number / sku
  code                  TEXT NOT NULL,                 -- e.g. 'missing_sku', 'unknown_sku', 'unmapped_courier', 'api_error'
  message               TEXT NOT NULL,
  resolved              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_log (                             -- only written when DEBUG_PAYLOADS=true; purge >14 days
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER,
  source                TEXT NOT NULL,
  payload               TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
