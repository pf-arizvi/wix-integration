# Wix ↔ Mintsoft Integration

Premium Fulfilment's in-house integration between client **Wix** stores and our **Mintsoft** WMS, running on **Cloudflare Workers + D1** (free plan).

- **F1 Order import:** paid, unfulfilled Wix orders → Mintsoft, every 5 min
- **F2 Despatch → fulfilment:** Mintsoft despatch webhook → Wix fulfilment with tracking
- **F3 Reconcile:** hourly safety net for missed webhooks
- **F4 Product import:** manual, at client onboarding (SKUs only, never stock)

Behaviour, mappings and data model: [`docs/SPEC.md`](docs/SPEC.md).

> **Status:** Phase 0 (scaffold). Flows are stubs; only `/healthz` and `/admin/health` respond.

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
