# Wix ↔ Mintsoft Integration — Specification

Owner: Premium Fulfilment (Technical Systems)
Status: v1 build
Hosting: Cloudflare Workers + D1 (free plan), repo `pf-arizvi/wix-integration`

---

## 1. Scope

### In scope (v1)
| # | Flow | Trigger |
|---|------|---------|
| F1 | Import paid, unfulfilled Wix orders into Mintsoft | Cron, every 5 min (+ manual admin trigger) |
| F2 | On Mintsoft despatch, create Wix fulfilment with tracking (marks order fulfilled, triggers Wix shipping email) | Mintsoft despatch webhook |
| F3 | Reconcile: despatched in Mintsoft but not fulfilled in Wix → run F2 | Cron, hourly |
| F4 | Import Wix products (variant SKUs) into Mintsoft for a client | Manual admin endpoint (onboarding) |
| F5 | Client onboarding/config via admin endpoints | Manual |

### Out of scope (v1)
- Order edits/updates after import (address changes, line changes) → later phase.
- Cancellations from Wix → later phase (log them, see §6.4).
- Stock/inventory sync (stock comes in via ASNs in Mintsoft; never push stock from Wix).
- Returns.
- A web UI (admin is JSON endpoints + curl for now).

---

## 2. Architecture

```
Cron (*/5)  ──► flows/importOrders ──► adapters/wix/orders ──► Wix
                         │                    
                         ├──► mapping/orderMapper (pure)
                         ├──► adapters/mintsoft/orders ──► Mintsoft (PUT /api/Order, ConnectActions)
                         └──► db/orderMap, db/errors

Mintsoft ──POST──► /webhooks/mintsoft/despatch/:clientSlug?token=…
                         └──► flows/pushTracking ──► adapters/wix/fulfilments ──► Wix

Cron (hourly) ──► flows/reconcile ──► Mintsoft (despatched since) ──► flows/pushTracking

Admin (Bearer ADMIN_TOKEN) ──► /admin/* ──► flows/importProducts, client config, manual runs
```

### Folder structure
```
src/
  index.ts                  # fetch + scheduled handlers, routing only
  router.ts
  config.ts                 # constants: MAX_ORDERS_PER_RUN, page sizes, cron names
  env.ts                    # Env type (bindings + secrets)
  lib/
    http.ts                 # fetch wrapper: timeout, retry/backoff, typed errors
    crypto.ts               # AES-GCM encrypt/decrypt for stored client keys
    auth.ts                 # admin bearer + webhook token checks
    log.ts                  # structured logging
  adapters/
    wix/
      client.ts             # base URL, auth headers per site
      orders.ts             # searchOrders, getOrder
      fulfilments.ts        # createFulfilment, listFulfilments
      catalog.ts            # getCatalogVersion, listVariants (V3), listProducts (V1)
      types.ts
    mintsoft/
      client.ts
      orders.ts             # createOrder, getOrder, setConnectActions, listDespatchedSince
      products.ts           # getProductBySku, createProduct
      types.ts
  mapping/
    orderMapper.ts          # Wix order → Mintsoft order request (pure)
    productMapper.ts        # Wix variant → Mintsoft product request (pure)
    trackingMapper.ts       # Mintsoft despatch payload → Wix fulfilment request (pure, defensive)
    courierMap.ts           # resolve Wix shipping option → Mintsoft CourierServiceId
    validation.ts
  flows/
    importOrders.ts
    pushTracking.ts
    reconcile.ts
    importProducts.ts
  db/
    clients.ts
    orderMap.ts
    courierMap.ts
    syncState.ts
    errors.ts
    webhookLog.ts
migrations/
  0001_init.sql
test/
  fixtures/wix-order-paid.json
  mapping/*.test.ts
  flows/*.test.ts           # adapters mocked
```

---

## 3. External APIs

### 3.1 Wix (base `https://www.wixapis.com`)
Auth headers on every call:
```
Authorization: <client's Wix API key>
wix-site-id: <client's Wix site ID>
Content-Type: application/json
```
Each client creates the API key in **their own** Wix account (keys only work on sites in the owning account), scoped to their site only, with permissions: **Manage Orders** (read + manage) and **read products** (Stores catalog).

| Purpose | Method + path | Notes |
|---|---|---|
| Search orders | `POST /ecom/v1/orders/search` | Body below. Cursor paging. |
| Create fulfilment | `POST /ecom/v1/fulfillments/orders/{wixOrderId}/create-fulfillment` | Uses Wix order **id** (UUID), not `number`. 409 `TRACKING_NUMBER_ALREADY_EXISTS` = already done → treat as success. |
| List fulfilments for order | `List Fulfillments for Single Order` | VERIFY exact path in docs. Used for idempotency in F3. |
| Catalog version | `GET /stores/v3/provision/version` | Returns `catalogVersion`: `V1_CATALOG` / `V3_CATALOG` / `STORES_NOT_INSTALLED`. Site uses one or the other — wrong version = calls fail. |
| Variants (Catalog V3) | `POST /stores/v3/products/query-variants` | Variant-centric, up to 1,000 per request. Weight only returned when `fields` includes `WEIGHT_MEASUREMENT_UNIT_INFO`. Follow-up pages send cursor only. |
| Products (Catalog V1) | `POST /stores/v1/products/query` | Variants nested in product. VERIFY. Not built yet (no V1 test site); V1 sites are refused with a clear error. |

Order search body (F1):
```json
{
  "search": {
    "filter": {
      "paymentStatus": { "$eq": "PAID" },
      "fulfillmentStatus": { "$eq": "NOT_FULFILLED" },
      "archived": { "$eq": false },
      "updatedDate": { "$gte": "<last_sync_cursor minus 10 min overlap>" }
    },
    "sort": [{ "fieldName": "updatedDate", "order": "ASC" }],
    "cursorPaging": { "limit": 15 }
  }
}
```
Confirmed working on the dev site (returns only paid + unfulfilled). `$eq` syntax confirmed.

Fulfilment body (F2) — VERIFY shape against docs:
```json
{
  "fulfillment": {
    "lineItems": [{ "id": "<wix lineItem id>", "quantity": 2 }],
    "trackingInfo": {
      "trackingNumber": "AB123456789GB",
      "shippingProvider": "Royal Mail",
      "trackingLink": "https://..."
    }
  }
}
```
- If `lineItems` is omitted, Wix fulfils the remaining unfulfilled quantity. v1: omit `lineItems` for full despatch; send explicit lines only for partial despatch (§6.3).
- UK carriers are mostly not Wix "predefined" providers → pass a custom provider name AND `trackingLink` (from Mintsoft).

### 3.2 Mintsoft (base `https://api.mintsoft.co.uk`)
Auth: `ms-apikey: <MINTSOFT_API_KEY>` (one warehouse-level key, Worker secret).

| Purpose | Method + path | Notes |
|---|---|---|
| Create order | `PUT /api/Order` | Body `NewOrderWithItems`; returns `[NewOrderResult]` (`Success`, `OrderId`, `Message`). Duplicate-OrderNumber behaviour unknown, so we pre-check instead (row below). |
| Register webhooks | Inline `ConnectAction` in the `PUT /api/Order` body (Swagger: "Optionally include ConnectAction"). `PUT /api/Order/{id}/ConnectActions` also exists. | `Type` = `API` (VERIFY: documented for ASN webhooks), `ExtraCode1` = despatch URL, `ExtraCode2` = cancel URL (VERIFY), `Complete` = false. `SourceOrderId` = Wix order number. Inline = no window where an order exists without its webhook. |
| Find order by number | `GET /api/Order/Search?OrderNumber=&exactMatch=true` | Returns `[Order]` incl. `ClientId`; filter ClientId client-side. Used for idempotency before every create. |
| SKU exists? | `GET /api/Product/LookupProductId?SKU=&ClientId=` | Returns product ID. VERIFY what an unknown SKU returns (handled: 0 / empty / 404). |
| Get order | `GET /api/Order/{id}` | Despatch webhook POSTs the same JSON as this call. Includes tracking number + URL. |
| Despatched since | Order list with `SinceDespatchDate` | 100/page cap. ClientId filter ignored on warehouse keys → filter client-side. |
| Products | `PUT /api/Product` (create; `POST` = update, never used), `GET /api/Product/{id}` | Body `Product`, required `SKU` + `Weight`; returns `NewProductResult` (`ProductId`, `Success`, `Message`). Existing check via LookupProductId (row above). |
| Clients | `GET /api/Client` | |

---

## 4. Mappings

### 4.1 Wix order → Mintsoft order (`mapping/orderMapper.ts`)
All Mintsoft field names: **VERIFY against Swagger** (keep in one object so they're easy to fix).

| Mintsoft | Wix source | Rule |
|---|---|---|
| ClientId | client config | |
| OrderNumber | `number` | e.g. "10002". Optional client prefix from config (e.g. `WX-10002`) to avoid clashes with other channels. |
| ExternalOrderReference | `id` | Wix UUID — needed for fulfilment. |
| FirstName / LastName | `recipientInfo.contactDetails.firstName/lastName` | Fallback: `shippingInfo.logistics.shippingDestination.contactDetails`, then `billingInfo`. |
| CompanyName | `recipientInfo.contactDetails.company` | if present |
| Address1 | `recipientInfo.address.addressLine` | Fallback `streetAddress.number + streetAddress.name` if `addressLine` missing. |
| Address2 | `recipientInfo.address.addressLine2` | if present |
| Town | `recipientInfo.address.city` | |
| County | `recipientInfo.address.subdivisionFullname` | Optional; for GB this is just "England" — omit for GB. |
| PostCode | `recipientInfo.address.postalCode` | Normalise: uppercase, single space before last 3 chars for GB (`HA54DF` → `HA5 4DF`). |
| Country | `recipientInfo.address.country` | ISO-2 ("GB"). VERIFY Mintsoft expects ISO-2. |
| Email | `buyerInfo.email` | |
| Phone | `recipientInfo.contactDetails.phone` | |
| CourierServiceId | `shippingInfo.title` / `shippingInfo.code` | Via `courier_map` table (§5). No match → client default; no default → hold order. |
| OrderValue | `priceSummary.total.amount` | number |
| ShippingTotalExVat | `priceSummary.shipping.amount` | Swagger has no `ShippingTotal`. "Values only": no line-level VAT split. |
| TotalVat | `priceSummary.tax.amount` | |
| Currency | `currency` | |
| OrderItems[].SKU | `lineItems[].physicalProperties.sku` | Required. Missing → hold whole order. |
| OrderItems[].Quantity | `lineItems[].quantity` | |
| OrderItems[].UnitPrice | `lineItems[].price.amount` | |
| Comments | `buyerNote` (if present) | Agreed: Comments (not DeliveryNotes). |

Line filtering:
- Skip lines where `physicalProperties.shippable === false` or `itemType.preset !== "PHYSICAL"` (digital, gift cards, services). If no shippable lines remain, record as `skipped_non_physical`.
- Use `recipientInfo` for delivery address, never `billingInfo` (gift orders).

### 4.2 Mintsoft despatch → Wix fulfilment (`mapping/trackingMapper.ts`)
Payload = Mintsoft order JSON (same as `GET /api/Order/{id}`). Exact field names UNCONFIRMED — parse defensively:
- tracking number: try `TrackingNumber`, then known alternates; log full keys if not found.
- tracking URL: try `TrackingURL` / `TrackingUrl`.
- courier name: try `CourierService.Name`, `CourierServiceName`, else client `default_carrier_name`.
- Wix order id: `ExternalOrderReference`, else look up via `order_map` by Mintsoft order id.
If no tracking number: still create the fulfilment without tracking? → **No.** Hold with error `missing_tracking` (operational decision; ask before changing).

### 4.3 Wix variant → Mintsoft product (`mapping/productMapper.ts`)
| Mintsoft | Wix (V3 variant) | Rule |
|---|---|---|
| SKU | variant `sku` | Required; missing → report, skip |
| Name | `productData.name` + option choice names | "Black Bag - Medium" (multiple options joined with " / ") |
| EAN | variant `barcode` | if present |
| Weight | variant `physicalProperties.weight` | kg (LB converted). VERIFY Mintsoft unit is kg. **No weight → create with 0 and flag `zero_weight`** (agreed). |
| Price | variant `price.actualPrice.amount` | Swagger field `Price`. |
| ClientId | client config | |
Never send stock quantities. Digital products skipped. **Hidden products/variants are imported** (agreed).

---

## 5. Data model (D1) — `migrations/0001_init.sql`

```sql
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
```

---

## 6. Flow behaviour

### 6.1 F1 — importOrders (cron `*/5 * * * *`)
For each active client, until `MAX_ORDERS_PER_RUN` (15) orders processed in total this run:
1. Read `orders_cursor` from `sync_state` (default: client creation time). Search Wix with `updatedDate >= cursor − 10 min` (overlap protects against clock skew).
2. For each order:
   - If `order_map` row exists with status not in (`held`) → skip (already handled).
   - If `held` → retry only if `attempts < 5` (errors may have been fixed, e.g. SKU added in Mintsoft).
   - Validate + map (§4.1). Validation failure → upsert `held` + `error_log`. Do not call Mintsoft.
   - Order Search by OrderNumber (filtered to the client). Found → store its id, mark `imported`, no create.
   - LookupProductId for every distinct SKU. Any missing → hold `unknown_sku` (whole order).
   - `PUT /api/Order` with inline ConnectAction (despatch URL `https://<worker>/webhooks/mintsoft/despatch/<slug>?token=<webhook_token>`). `Success=false` → hold.
   - `GET /api/Order/{id}` and confirm `ClientId` matches. Mismatch → deactivate client, `mintsoft_client_mismatch`, halt the run.
   - Upsert `order_map` = `imported`.
   - Held orders are retried when they reappear in the search window; otherwise via the admin retry endpoint (Phase 3).
3. Advance `orders_cursor` to the max `updatedDate` fully processed (not past any order left unprocessed due to the batch cap).
4. Rotate client order between runs so one busy client can't starve others.

### 6.2 F2 — pushTracking (webhook)
`POST /webhooks/mintsoft/despatch/:slug?token=…`
1. Validate slug + token (constant-time compare). 401 otherwise.
2. Respond quickly; do the work in-request (it's one order) — keep CPU tiny.
3. Map payload (§4.2). Find `order_map` row.
4. Idempotency: if status already `fulfilled` → 200 no-op.
5. Create Wix fulfilment. 409 tracking already exists → treat as success.
6. Update `order_map` → `fulfilled` (store tracking number). On failure → `fulfil_failed` + `error_log`; F3 retries.
7. Always return 200 to Mintsoft once the request is authenticated and logged (avoid retry storms); failures are retried by F3.

### 6.3 Partial despatch / split orders
Mintsoft can split orders. v1 behaviour: if the despatch payload contains item-level quantities that are less than the Wix order quantities, send explicit `lineItems` with despatched quantities (match by SKU → Wix line item id). Otherwise omit `lineItems`. **Flag this area with `// VERIFY:`** and ask me before finalising — needs testing with a real split in Mintsoft.

### 6.4 Cancellations
Mintsoft `ExtraCode2` cancel webhook → log to `error_log` with code `mintsoft_cancelled` for manual follow-up. Wix-side cancellations: out of scope v1, but F1 must never import an order whose Wix `status` is `CANCELED`.

### 6.5 F3 — reconcile (cron `0 * * * *`)
1. Per client: list Mintsoft orders despatched since `reconcile_since − 2h` (page through 100-cap; filter by ClientId client-side).
2. For each with a matching `order_map` row not `fulfilled` → run pushTracking logic.
3. Also retry `fulfil_failed` rows (max attempts 5, then leave for manual).
4. Respect batch caps; advance `reconcile_since`.

### 6.6 F4 — importProducts (admin, manual)
`POST /admin/clients/:slug/import-products?dryRun=true|false&cursor=…&maxCreates=N` (dry run by default)
1. Detect catalog version (cached on the client row after a real run). V1 → refused for now.
2. Page through variants (V3 Read-Only Variants), 12 per request (worst case 3 Mintsoft calls each).
3. For each variant: skip digital; missing SKU → report; duplicate SKU within Wix → report; SKU exists in Mintsoft for the client → skip (never overwrite); else create, then read back and confirm ClientId.
4. The first create in each request is looked up again by SKU. If the lookup doesn't return it, halt (an untrusted existing-SKU check would create duplicates on re-runs).
5. Must handle large catalogues within free-plan limits: one page per request, return `nextCursor`. If stopped part-way (maxCreates, budget, API error), `nextCursor` is the same page; re-running it is safe. `scripts/import-products.sh` loops.
6. Return a report: created / wouldCreate / skippedExisting / missingSku / duplicateSkuInWix / skippedNonPhysical / errors, with `zero_weight` flags.

### 6.7 Admin endpoints (Bearer `ADMIN_TOKEN`)
- `POST /admin/clients` — create client (body: name, slug, mintsoft_client_id, mintsoft_client_name, wix_site_id, wix_api_key, defaults, optional import_orders_since). Encrypts key, generates webhook token, detects catalog version (Phase 4), test-calls Wix + Mintsoft, returns webhook URL.
- `GET /admin/clients` — list (never return keys).
- `PUT /admin/clients/:slug/courier-map` — upsert mappings.
- `POST /admin/clients/:slug/import-products` — run F4, one page (§6.6).
- `POST /admin/clients/:slug/run-import` — run F1 for one client now.
- `POST /admin/clients/:slug/orders/:wixOrderNumber/retry` — retry a held/failed order.
- `GET /admin/errors?unresolved=1` and `POST /admin/errors/:id/resolve`.
- `GET /admin/health` — last run times per flow, counts by status.

---

## 7. Configuration & secrets

`wrangler.jsonc` (or `.toml`): D1 binding `DB`, crons `["*/5 * * * *", "0 * * * *"]`, vars `MAX_ORDERS_PER_RUN=15`, `DEBUG_PAYLOADS=false`, `WORKER_BASE_URL`, `MINTSOFT_WRITES_ENABLED=false`, `MINTSOFT_ALLOWED_CLIENT_IDS=38`.

### 7.1 Mintsoft write guardrails
Enforced in `src/adapters/mintsoft/client.ts` (every write goes through one guarded function):
1. **Kill switch** `MINTSOFT_WRITES_ENABLED`: only the exact string `true` enables writes (orders and products alike). Otherwise the cron import is skipped and `run-import` / `import-products` are dry runs that write nothing anywhere (Mintsoft, order_map, error_log, cursor, catalog_version) and return would-be payloads. While it is on, the 5-minute cron also imports orders.
2. **ClientId allowlist** `MINTSOFT_ALLOWED_CLIENT_IDS`: any write whose body ClientId is not listed is refused before the request is sent.
3. **Onboarding check**: `POST /admin/clients` requires `mintsoft_client_name`, and it must exactly equal the Name Mintsoft has for that ID.
4. **Read-back**: after create, `GET /api/Order/{id}` / `GET /api/Product/{id}` must report the expected ClientId, otherwise the client is deactivated and the run halts.
5. **Lookup proof** (products): the first product created per request must be found again by LookupProductId, otherwise the import halts.

Secrets (`wrangler secret put`, and `.dev.vars` locally):
- `MINTSOFT_API_KEY`
- `ADMIN_TOKEN` (long random)
- `ENCRYPTION_KEY` (32-byte base64 for AES-GCM)

Provide `.dev.vars.example` with placeholder names only.

---

## 8. Error handling & alerting
- Every handled failure → `error_log` row with a machine `code` + human message (e.g. "Order 10005 held: SKU BLKBAGXL not found in Mintsoft client 123").
- v1 alerting: `GET /admin/health` + `/admin/errors`. Phase 5 adds an email/Slack/Teams notification for new unresolved errors (one digest per hour max).

Standard error codes: `missing_sku`, `unknown_sku`, `unmapped_courier`, `no_physical_lines`, `invalid_address`, `wix_api_error`, `mintsoft_api_error`, `missing_tracking`, `order_not_found`, `mintsoft_cancelled`.

---

## 9. Testing

### Environments
- Wix: free **Premium dev site** "Mintsoft Test" (Catalog V3, GBP/KG, Standard + Express shipping, products `BLKBAGSMALL`, `BLKBAGMEDIUM`).
- Mintsoft: "Wix test client" in our Mintsoft account.
- Despatch webhook during early testing: webhook.site URL, then the deployed Worker URL.

### Automated
- Unit tests for all mappers using `test/fixtures/wix-order-paid.json` (real dev-site order, personal data replaced).
- Flow tests with adapters mocked: idempotency (run twice → one Mintsoft order), held-order retry, cursor advance with batch cap, 409 on fulfilment = success.

### Manual acceptance checklist (before client onboarding)
- [ ] Simple order imports with correct address, items, courier
- [ ] Multi-line order, variant products
- [ ] Unpaid order NOT imported
- [ ] Order with SKU missing in Mintsoft → held with clear error; fixing SKU + retry imports it
- [ ] Order with no SKU in Wix → held
- [ ] Unmapped shipping method → default courier or held
- [ ] Same order never duplicated (re-run import, re-send to Mintsoft)
- [ ] Despatch in Mintsoft → Wix shows Fulfilled, tracking link works, customer gets shipping email
- [ ] Missed webhook → reconcile fixes it within the hour
- [ ] Product import: creates new SKUs, skips existing, reports missing SKUs, no stock touched
- [ ] Logs show CPU time comfortably under 10 ms per invocation

---

## 10. Build phases (stop after each for review)

> **Reordered (2026-11-15):** product import was moved ahead of order import going live. Products must exist in Mintsoft before orders can import (otherwise every order is held `unknown_sku`), so onboarding order is: create client → import products → courier map → orders. Phase 4 below was built straight after Phase 1; Phases 2, 3 and 5 follow.

**Phase 0 — Scaffold**
Wrangler TS project in this repo, D1 binding + migration 0001, router, env types, `lib/http.ts`, `lib/crypto.ts`, `lib/auth.ts`, vitest set up, npm scripts, `.gitignore`, `.dev.vars.example`, README with setup steps.

**Phase 1 — Order import (F1)**
Wix orders adapter, Mintsoft orders adapter (create + ConnectActions), orderMapper + validation + courierMap, importOrders flow, admin: create client, courier map, run-import. Unit + flow tests.
*Acceptance:* order 10002 on dev site appears in Mintsoft test client; re-run does not duplicate.

**Phase 2 — Despatch → fulfilment (F2)**
Webhook route, trackingMapper (defensive), Wix fulfilments adapter, pushTracking flow, `DEBUG_PAYLOADS` logging. Use first real payload to finalise field names.
*Acceptance:* despatching in Mintsoft marks the Wix order Fulfilled with tracking.

**Phase 3 — Reconcile (F3) + health/errors endpoints**

**Phase 4 — Product import (F4)** incl. V1/V3 detection and `scripts/import-products.sh`. *(Built after Phase 1; V1 catalogue support deferred until a V1 site is available.)*
*Acceptance:* dev-site variants `BLKBAGSMALL` / `BLKBAGMEDIUM` created in Mintsoft client 38; re-run creates nothing; order 10002 dry run then shows `would_import`.

**Phase 5 — Hardening**
Alert digest, payload purge job, client rotation fairness, README runbook (onboarding a new client step-by-step, rotating keys, common errors).
