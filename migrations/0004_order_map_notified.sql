-- When an order with an unknown SKU was sent to Mintsoft anyway so Mintsoft raises its own
-- connect error for the warehouse team. Automatic retries don't re-send once this is set.
ALTER TABLE order_map ADD COLUMN mintsoft_notified_at TEXT;
CREATE INDEX idx_order_map_held ON order_map(status, updated_at);
