-- Mintsoft CourierServiceId → carrier name shown to the customer in Wix (fulfilment shippingProvider).
-- Global: courier service IDs are the same for every Mintsoft client.
-- Needed because Mintsoft's despatch payload carries CourierServiceId but CourierServiceName is null.
CREATE TABLE carrier_names (
  mintsoft_courier_service_id INTEGER PRIMARY KEY,
  display_name                TEXT NOT NULL,
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
