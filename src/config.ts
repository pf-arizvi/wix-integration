import type { Env } from "./env";

/**
 * Operational constants. External API shapes (base URLs, field names) live in
 * src/adapters/*, not here.
 */

/** Cron expressions. Must match `triggers.crons` in wrangler.jsonc. */
export const CRON = {
  IMPORT_ORDERS: "*/5 * * * *",
  RECONCILE: "0 * * * *",
} as const;

/** Default cap on orders processed across all clients in one F1 run. */
export const DEFAULT_MAX_ORDERS_PER_RUN = 15;

/** Wix order search page size (cursorPaging.limit). Never above the run cap. */
export const WIX_ORDER_PAGE_SIZE = 15;

/** Mintsoft Order/List hard cap. */
export const MINTSOFT_ORDER_LIST_PAGE_SIZE = 100;

/**
 * Outbound fetch() budget per invocation (Wix + Mintsoft, retries included).
 * Free plan limit is 50 subrequests; we keep headroom.
 * VERIFY: whether D1 queries share this limit or have a separate per-invocation
 * cap on the free plan. Flows should batch D1 writes either way.
 */
export const SUBREQUEST_BUDGET = 45;

/** Per-attempt timeout for external HTTP calls. */
export const HTTP_TIMEOUT_MS = 10_000;

/** Total attempts per external call (1 initial + 2 retries) on 429/5xx. */
export const HTTP_MAX_ATTEMPTS = 3;

/** F1: overlap subtracted from orders_cursor to tolerate clock skew. */
export const ORDERS_CURSOR_OVERLAP_MS = 10 * 60 * 1000;

/** F3: overlap subtracted from reconcile_since. */
export const RECONCILE_OVERLAP_MS = 2 * 60 * 60 * 1000;

/** Held / fulfil_failed orders are retried automatically up to this many attempts. */
export const MAX_AUTO_ATTEMPTS = 5;

/** webhook_log rows older than this are purged. */
export const WEBHOOK_LOG_RETENTION_DAYS = 14;

export function maxOrdersPerRun(env: Pick<Env, "MAX_ORDERS_PER_RUN">): number {
  const n = Number.parseInt(env.MAX_ORDERS_PER_RUN, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ORDERS_PER_RUN;
}

export function debugPayloads(env: Pick<Env, "DEBUG_PAYLOADS">): boolean {
  return env.DEBUG_PAYLOADS === "true";
}

/** Only the exact string "true" enables Mintsoft writes. Missing/typo = disabled. */
export function mintsoftWritesEnabled(env: Pick<Env, "MINTSOFT_WRITES_ENABLED">): boolean {
  return env.MINTSOFT_WRITES_ENABLED === "true";
}

/** F4: Wix variants per import-products request. Worst case per variant: lookup + create + read-back = 3 calls. */
export const PRODUCT_IMPORT_PAGE_SIZE = 12;

/** Parses MINTSOFT_ALLOWED_CLIENT_IDS. Invalid entries are dropped (never widen access). */
export function allowedMintsoftClientIds(env: Pick<Env, "MINTSOFT_ALLOWED_CLIENT_IDS">): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const part of (env.MINTSOFT_ALLOWED_CLIENT_IDS ?? "").split(",")) {
    const s = part.trim();
    if (/^[1-9]\d*$/.test(s)) ids.add(Number(s));
  }
  return ids;
}

/** Estimated Mintsoft + Wix calls to import one order (pre-check, SKU lookups, create, read-back). */
export function callsToImportOrder(distinctSkus: number): number {
  return 3 + distinctSkus;
}

/** Max pages of GET /api/Client scanned when verifying a client at onboarding (100 per page). */
export const MINTSOFT_CLIENT_SCAN_MAX_PAGES = 10;
