# Wix ↔ Mintsoft Integration

Premium Fulfilment's in-house integration between client **Wix** stores and our **Mintsoft** WMS, running on **Cloudflare Workers + D1** (free plan).

- **F1 Order import:** paid, unfulfilled Wix orders → Mintsoft, every 5 min
- **F2 Despatch → fulfilment:** Mintsoft despatch webhook → Wix fulfilment with tracking
- **F3 Reconcile:** hourly safety net for missed webhooks
- **F4 Product import:** manual, at client onboarding (SKUs only, never stock)

Behaviour, mappings and data model: [`docs/SPEC.md`](docs/SPEC.md).

> **Status:** Order import + product import built. All Mintsoft writes are **off** by default (see Guardrails).

---

## Prerequisites

- Node **24+** (`nvm use` reads `.nvmrc`)
- A Cloudflare account with access to the Premium Fulfilment Workers
- Wrangler is a dev dependency; use `npx wrangler …` (no global install needed)

## Local setup

```sh
npm install
cp .dev.vars.example .dev.vars      # then fill in values (see below)
npm run db:migrate:local            # creates local D1 under .wrangler/
npm run dev                         # http://localhost:8787
```

`.dev.vars` values:

| Name | How to get it |
|---|---|
| `MINTSOFT_API_KEY` | Mintsoft warehouse-level API key |
| `ADMIN_TOKEN` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (must decode to 32 bytes) |
| `WORKER_BASE_URL` | `http://localhost:8787` locally |
| `DEBUG_PAYLOADS` | `false` unless capturing webhook payloads |

`.dev.vars` is git-ignored. Never commit real values.

Smoke test:

```sh
curl localhost:8787/healthz
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8787/admin/health
# Trigger crons locally (requires `npx wrangler dev --test-scheduled`):
curl "localhost:8787/__scheduled?cron=*/5+*+*+*+*"
curl "localhost:8787/__scheduled?cron=0+*+*+*+*"
```

## Cloudflare setup (once)

```sh
npx wrangler login
npx wrangler whoami                       # confirm the right account
npx wrangler d1 create wix-integration --location weur
```

Copy the `database_id` from the output into `wrangler.jsonc` → `d1_databases[0].database_id`, then:

```sh
npm run db:migrate:remote
npx wrangler secret put MINTSOFT_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ENCRYPTION_KEY
npm run deploy
```

After the first deploy, set `WORKER_BASE_URL` in `wrangler.jsonc` to the deployed URL (e.g. `https://wix-integration.<account>.workers.dev`) and deploy again. It is used to build the Mintsoft despatch webhook URLs.

> ⚠️ `ENCRYPTION_KEY` decrypts every stored client Wix API key. Keep a copy in the team password manager. Losing it means re-entering every client's key, and changing it requires re-encrypting them.

## Mintsoft write guardrails

Nothing is written to Mintsoft unless **both** are true. Both are checked in `src/adapters/mintsoft/client.ts` before any request leaves the Worker:

| Var (`wrangler.jsonc`) | Default | Effect |
|---|---|---|
| `MINTSOFT_WRITES_ENABLED` | `"false"` | Only the exact string `"true"` allows any write (orders or products). Otherwise the cron import is skipped, and `run-import` and `import-products` are dry runs. |
| `MINTSOFT_ALLOWED_CLIENT_IDS` | `"38"` | Comma-separated. A write for any other ClientId is refused. |
| `MINTSOFT_WAREHOUSE_ID` | `"3"` | WarehouseId sent on every order (Mintsoft requires one). The same for all clients. If it's missing or invalid, order import refuses to run. |

On top of that:
- **Onboarding** checks the client's ID and exact name against Mintsoft before anything is saved.
- **Every created order and product is read back** to confirm its ClientId. On a mismatch the client is deactivated and the run halts.
- **The SKU lookup is proven before it's trusted.** After the first product created in each request, the import looks that SKU up again. If the lookup doesn't return the new product, the import halts, because a lookup it can't trust would create duplicates on the next run.

> ⚠️ **While writes are on, the 5-minute cron also imports paid, unfulfilled Wix orders** for every active client. Turn writes on only for as long as needed, and only after checking which orders would import (run the order dry run first).

A **dry run** writes nothing anywhere: not Mintsoft, and not D1 (no rows, no errors, cursor unchanged). It returns the exact payloads that *would* be sent. Order payloads include customer name and address, so dry runs are admin-only and never logged.

To switch writes on for a one-off job without committing `"true"`, pass the var at deploy time. Then deploy again without it to switch back off:
```sh
npx wrangler deploy --var MINTSOFT_WRITES_ENABLED:true   # on
npm run deploy                                            # back to the committed "false"
```

## Onboarding a client (admin API)

Set up your terminal first. `.env` (git-ignored) holds `ADMIN_KEY` (the production `ADMIN_TOKEN`) and the client's Wix key:
```sh
set -a; source .env; set +a
export BASE=https://wix-integration.pf-integrations.workers.dev
```

**Order matters: products must be in Mintsoft before orders are imported**, otherwise every order is held with `unknown_sku`.

### 1. Create the client
This writes nothing to Mintsoft or Wix. `mintsoft_client_name` must exactly match the name in Mintsoft for that ID. `import_orders_since` imports paid orders updated since that time (default: now).
```sh
curl -sS -X POST "$BASE/admin/clients" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" --data-binary @- <<EOF
{
  "slug": "wix-test",
  "name": "Wix Test Client",
  "mintsoft_client_id": 38,
  "mintsoft_client_name": "Wix Test Client",
  "wix_site_id": "<wix site id>",
  "wix_api_key": "$WIX_TEST_API_KEY",
  "default_courier_service_id": 16,
  "default_carrier_name": "Royal Mail",
  "import_orders_since": "2026-11-15T00:00:00Z"
}
EOF
```
The response includes webhook URLs containing the client's secret token. Don't paste those anywhere.

### 2. Import products (Wix variant SKUs → Mintsoft)
SKUs already in Mintsoft are skipped and never overwritten. Stock is never sent. A variant with no weight in Wix is created with Weight 0 and listed under `zeroWeight`. Each page's full report is saved to `./import-reports/` (git-ignored).
```sh
scripts/import-products.sh wix-test                         # dry run: what would be created
# switch writes on (see above), then:
scripts/import-products.sh wix-test --apply --max-creates 1 # first: create ONE product and prove the lookup
scripts/import-products.sh wix-test --apply                 # then the rest
# switch writes back off
```

### 3. Map Wix shipping methods to Mintsoft courier services
Optional if the client's default courier is enough.
```sh
curl -sS -X PUT "$BASE/admin/clients/wix-test/courier-map" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "mappings": [
    { "wix_shipping_title": "Standard Shipping", "mintsoft_courier_service_id": 1, "carrier_display_name": "Royal Mail" },
    { "wix_shipping_title": "Express Shipping",  "mintsoft_courier_service_id": 2, "carrier_display_name": "DPD" }
  ]
}'
```

### 4. Orders: dry run first, then real
```sh
curl -sS -X POST "$BASE/admin/clients/wix-test/run-import" -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
# Real import, only with MINTSOFT_WRITES_ENABLED="true" deployed:
curl -sS -X POST "$BASE/admin/clients/wix-test/run-import?dryRun=false" -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
```

### 5. Despatch → Wix fulfilment (automatic)
When an order is despatched in Mintsoft, Mintsoft calls the despatch webhook registered on that order. The integration then creates a Wix fulfilment with the tracking number and link, which marks the order Fulfilled (or Partially Fulfilled for a split) and may send Wix's shipping email to the buyer. Untracked despatches are still fulfilled, without tracking. Mintsoft cancellations are logged as `mintsoft_cancelled` errors for manual follow-up. Nothing is written to Mintsoft.

Mintsoft calls the webhook about 10 minutes after despatch. As a safety net, **reconcile** runs every 5 minutes (2 minutes after each import). It asks Mintsoft (read-only) which orders were despatched and fulfils any of ours that Wix doesn't have yet. Run it on demand with:
```sh
curl -sS -X POST "$BASE/admin/reconcile" -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
```

**Carrier names shown in Wix.** Mintsoft's despatch says which courier service was used (`CourierServiceId`) but not its name. Map each service ID to the name customers should see:
```sh
curl -sS -X PUT "$BASE/admin/carriers" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "carriers": [
    { "mintsoft_courier_service_id": 14,   "display_name": "Royal Mail" },
    { "mintsoft_courier_service_id": 16,   "display_name": "Royal Mail" },
    { "mintsoft_courier_service_id": 1514, "display_name": "Collection" }
  ]
}'
```
If a service has no entry, the name falls back to the courier map's `carrier_display_name`, then to the client's default carrier.

To capture raw webhook payloads while testing (they contain addresses; purged after 14 days), switch logging on, then off again afterwards:
```sh
npx wrangler deploy --var DEBUG_PAYLOADS:true
npm run deploy
```

List clients (never shows keys or webhook tokens):
```sh
curl -sS "$BASE/admin/clients" -H "Authorization: Bearer $ADMIN_KEY"
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | `wrangler dev` with local D1 |
| `npm test` | Vitest inside the Workers runtime (local D1, migrations auto-applied, per-test isolated storage) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run types` | Regenerate `worker-configuration.d.ts` (runtime types). Rerun after changing `compatibility_date` |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply `migrations/` to local / production D1 |
| `npm run deploy` | `wrangler deploy` |

## Layout

```
src/
  index.ts, router.ts      fetch + scheduled entry, routing only
  config.ts, env.ts        constants (batch caps, page sizes, crons) and Env type
  lib/                     http (timeout/retry/budget), crypto (AES-GCM), auth, log, response
  adapters/wix|mintsoft/   the ONLY code that knows external API shapes
  mapping/                 pure Wix ↔ Mintsoft mapping functions
  flows/                   orchestration: importOrders, pushTracking, reconcile, importProducts
  db/                      D1 repositories (no SQL elsewhere)
migrations/                D1 schema (0001_init.sql = SPEC §5)
test/                      vitest: lib/, mapping/, flows/, fixtures/
```

## Free-plan guardrails

- 10 ms CPU per invocation. Waiting on `fetch`/D1 is free; parsing/mapping is not.
- `MAX_ORDERS_PER_RUN` (default 15) caps F1 across all clients. Leftovers run next time.
- Every outbound call goes through `lib/http.ts` and draws from a per-invocation `SubrequestBudget` (45, under the 50 limit). Retries count too.
- 2 of the 5 allowed cron triggers are used.
