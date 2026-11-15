# Wix ↔ Mintsoft Integration

Premium Fulfilment's in-house integration between client **Wix** stores and our **Mintsoft** WMS, running on **Cloudflare Workers + D1** (free plan).

- **F1 Order import:** paid, unfulfilled Wix orders → Mintsoft, every 5 min
- **F2 Despatch → fulfilment:** Mintsoft despatch webhook → Wix fulfilment with tracking
- **F3 Reconcile:** hourly safety net for missed webhooks
- **F4 Product import:** manual, at client onboarding (SKUs only, never stock)

Behaviour, mappings and data model: [`docs/SPEC.md`](docs/SPEC.md).

> **Status:** Phase 1 (order import). Mintsoft writes are **off** by default (see Guardrails).

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

Nothing is written to Mintsoft unless **both** are true (checked in `src/adapters/mintsoft/client.ts` before any request leaves the Worker):

| Var (`wrangler.jsonc`) | Default | Effect |
|---|---|---|
| `MINTSOFT_WRITES_ENABLED` | `"false"` | Only the exact string `"true"` enables writes. Otherwise the cron import is skipped and `run-import` is a dry run. |
| `MINTSOFT_ALLOWED_CLIENT_IDS` | `"38"` | Comma-separated. A write for any other ClientId is refused. |

On top of that, onboarding checks the client's ID and exact name against Mintsoft, and every created order is read back to confirm its ClientId. On a mismatch the client is deactivated and the run halts.

A **dry run** writes nothing anywhere: not Mintsoft, not D1 (no order rows, no errors, cursor unchanged). It returns the exact payload that *would* be sent. That includes customer name and address, so it's admin-only and never logged.

## Onboarding a client (admin API)

All `/admin/*` calls need `-H "Authorization: Bearer $ADMIN_TOKEN"`. `BASE=https://wix-integration.pf-integrations.workers.dev`.

```sh
# 1. Create the client. Nothing is written to Mintsoft or Wix.
#    mintsoft_client_name must EXACTLY match the name in Mintsoft for that ID.
#    import_orders_since: import paid orders updated since then (default: now).
curl -X POST $BASE/admin/clients -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
  "slug": "wix-test",
  "name": "Wix Test Client",
  "mintsoft_client_id": 38,
  "mintsoft_client_name": "Wix Test Client",
  "wix_site_id": "<wix site id>",
  "wix_api_key": "<wix api key>",
  "default_courier_service_id": <mintsoft courier service id>,
  "default_carrier_name": "Royal Mail",
  "import_orders_since": "2026-11-15T00:00:00Z"
}'

# 2. Map Wix shipping methods to Mintsoft courier services (optional if the default is enough)
curl -X PUT $BASE/admin/clients/wix-test/courier-map -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
  "mappings": [
    { "wix_shipping_title": "Standard Shipping", "mintsoft_courier_service_id": 1, "carrier_display_name": "Royal Mail" },
    { "wix_shipping_title": "Express Shipping",  "mintsoft_courier_service_id": 2, "carrier_display_name": "DPD" }
  ]
}'

# 3. Dry run: see exactly what would be sent (default; safe any time)
curl -X POST "$BASE/admin/clients/wix-test/run-import" -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Real import: only once MINTSOFT_WRITES_ENABLED="true" has been deployed
curl -X POST "$BASE/admin/clients/wix-test/run-import?dryRun=false" -H "Authorization: Bearer $ADMIN_TOKEN"

# List clients (never shows keys or webhook tokens)
curl $BASE/admin/clients -H "Authorization: Bearer $ADMIN_TOKEN"
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
