/**
 * Admin JSON endpoints (Bearer ADMIN_TOKEN, applied in index.ts via adminOnly).
 * Handlers validate input and delegate to flows / db. No business logic here.
 */
import { allowedMintsoftClientIds, maxOrdersPerRun, mintsoftWarehouseId } from "../config";
import { getClientBySlug, listActiveClients, listClients, toPublicClient } from "../db/clients";
import { type CarrierName, listCarrierNames, upsertCarrierNames } from "../db/carrierNames";
import { listCourierRules, upsertCourierRules } from "../db/courierMap";
import { listErrors, resolveError } from "../db/errors";
import { countOrdersByStatus, getOrderMapByWixNumber, listOrderMaps, type OrderStatus } from "../db/orderMap";
import { audit, auditStatement, listAudit, listSettings, setSettingStatement } from "../db/settings";
import { accessConfig } from "../lib/access";
import { createFlowDeps, mintsoftWritesState } from "../flows/deps";
import { ImportConfigError, ImportHaltedError, importOrdersForClient, retryOrder } from "../flows/importOrders";
import { importProductsPage } from "../flows/importProducts";
import { inspectCourierMappings } from "../flows/inspectCouriers";
import { reconcileOnce } from "../flows/reconcile";
import { onboardClient, type OnboardInput } from "../flows/onboardClient";
import type { FlowDeps } from "../flows/ports";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { log } from "../lib/log";
import { errorJson, json, readJsonObject } from "../lib/response";
import type { CourierRule } from "../mapping/courierMap";
import type { Handler } from "../router";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PREFIX_RE = /^[A-Za-z0-9_-]{0,10}$/;

class BadInput extends Error {}

function str(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | null {
  const v = body[key];
  if (v == null || v === "") {
    if (opts.required) throw new BadInput(`${key} is required`);
    return null;
  }
  if (typeof v !== "string") throw new BadInput(`${key} must be a string`);
  const s = v.trim();
  if (opts.required && !s) throw new BadInput(`${key} is required`);
  if (s.length > (opts.max ?? 200)) throw new BadInput(`${key} is too long`);
  return s || null;
}

function posInt(body: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): number | null {
  const v = body[key];
  if (v == null || v === "") {
    if (opts.required) throw new BadInput(`${key} is required`);
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new BadInput(`${key} must be a positive integer`);
  return v;
}

async function withDeps(env: Env): Promise<FlowDeps | Response> {
  try {
    return await createFlowDeps(env);
  } catch (err) {
    log.error("admin.deps_failed", { err });
    return errorJson(503, "config_error", err instanceof Error ? err.message : "Configuration error");
  }
}

export function parseOnboardInput(body: Record<string, unknown>): OnboardInput {
  const slug = str(body, "slug", { required: true, max: 40 })!;
  if (!SLUG_RE.test(slug)) throw new BadInput("slug must be 2-40 chars: lowercase letters, digits, hyphens");
  const prefix = str(body, "order_number_prefix", { max: 10 }) ?? "";
  if (!PREFIX_RE.test(prefix)) throw new BadInput("order_number_prefix: up to 10 letters, digits, '-' or '_'");
  const since = str(body, "import_orders_since", { max: 40 });
  if (since && Number.isNaN(Date.parse(since))) throw new BadInput("import_orders_since must be an ISO 8601 timestamp");
  return {
    slug,
    name: str(body, "name", { required: true })!,
    mintsoftClientId: posInt(body, "mintsoft_client_id", { required: true })!,
    mintsoftClientName: str(body, "mintsoft_client_name", { required: true })!,
    wixSiteId: str(body, "wix_site_id", { required: true })!,
    wixApiKey: str(body, "wix_api_key", { required: true, max: 4000 })!,
    orderNumberPrefix: prefix,
    defaultCourierServiceId: posInt(body, "default_courier_service_id"),
    defaultCarrierName: str(body, "default_carrier_name"),
    importOrdersSince: since ? new Date(since).toISOString() : null,
  };
}

/** POST /admin/clients */
export const createClientHandler: Handler = async ({ request, env, actor }) => {
  const body = await readJsonObject(request);
  if (!body) return errorJson(400, "invalid_json", "Body must be a JSON object");
  let input: OnboardInput;
  try {
    input = parseOnboardInput(body);
  } catch (err) {
    if (err instanceof BadInput) return errorJson(400, "invalid_input", err.message);
    throw err;
  }
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;
  const result = await onboardClient(deps, input);
  if (!result.ok) return errorJson(result.status, result.error, result.message);
  await audit(env.DB, actor ?? "unknown", "client.create", `${result.client.slug} → Mintsoft client ${result.client.mintsoftClientId}`);
  log.info("admin.client_created", { client: result.client.slug, mintsoftClientId: result.client.mintsoftClientId });
  return json({ client: result.client, mintsoft_client: result.mintsoftClient, webhooks: result.webhooks }, 201);
};

/**
 * GET /admin/mintsoft/courier-services?offset=0&limit=40&includeInactive=false
 * Read-only: Mintsoft courier services + the external names mapped to each.
 */
export const courierServicesHandler: Handler = async ({ env, url }) => {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "40");
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40) {
    return errorJson(400, "invalid_input", "offset must be >= 0 and limit 1-40");
  }
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;
  try {
    const result = await inspectCourierMappings(deps, { offset, limit, includeInactive: url.searchParams.get("includeInactive") === "true" });
    return json({ ...result, subrequestsLeft: deps.budget.remaining });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(502, "mintsoft_api_error", err.message);
    throw err;
  }
};

/** GET /admin/carriers — Mintsoft CourierServiceId → carrier name shown in Wix. */
export const listCarriersHandler: Handler = async ({ env }) => json({ carriers: await listCarrierNames(env.DB) });

/** PUT /admin/carriers  body: { carriers: [{ mintsoft_courier_service_id, display_name }] } (upsert). */
export const putCarriersHandler: Handler = async ({ request, env, actor }) => {
  const body = await readJsonObject(request);
  const list = body?.carriers;
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
    return errorJson(400, "invalid_input", "carriers must be a non-empty array (max 100)");
  }
  let names: CarrierName[];
  try {
    names = list.map((m: unknown, i) => {
      if (!m || typeof m !== "object") throw new BadInput(`carriers[${i}] must be an object`);
      const o = m as Record<string, unknown>;
      return {
        mintsoftCourierServiceId: posInt(o, "mintsoft_courier_service_id", { required: true })!,
        displayName: str(o, "display_name", { required: true, max: 100 })!,
      };
    });
  } catch (err) {
    if (err instanceof BadInput) return errorJson(400, "invalid_input", err.message);
    throw err;
  }
  await upsertCarrierNames(env.DB, names);
  await audit(env.DB, actor ?? "unknown", "carriers.update", names.map((n) => `${n.mintsoftCourierServiceId}=${n.displayName}`).join(", "));
  return json({ carriers: await listCarrierNames(env.DB) });
};

/**
 * POST /admin/clients/:slug/orders/:wixOrderNumber/retry?dryRun=true|false&notify=true
 * Re-runs the import for one recorded order now (e.g. after adding a missing SKU in Mintsoft).
 * Defaults to a DRY RUN. notify=true re-sends an unknown-SKU order to Mintsoft so it raises its
 * connect error again (a Mintsoft write attempt; it is rejected, nothing is created).
 */
export const retryOrderHandler: Handler = async ({ env, params, url, actor }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  if (!client.active) return errorJson(409, "client_inactive", `Client ${client.slug} is inactive`);
  const row = await getOrderMapByWixNumber(env.DB, client.id, params.wixOrderNumber!);
  if (!row) return errorJson(404, "order_not_found", `No recorded order ${params.wixOrderNumber} for ${client.slug}`);
  if (row.status !== "held") return errorJson(409, "not_held", `Order ${row.wixOrderNumber} is '${row.status}', not held`);
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;
  const requestedDryRun = url.searchParams.get("dryRun") !== "false";
  try {
    const outcome = await retryOrder(deps, client, row, { dryRun: requestedDryRun, forceNotify: url.searchParams.get("notify") === "true" });
    if (!requestedDryRun && deps.wms.writesEnabled) {
      await audit(env.DB, actor ?? "unknown", "order.retry", `${client.slug} ${row.wixOrderNumber}: ${outcome.outcome}`);
    }
    return json({
      dryRun: requestedDryRun || !deps.wms.writesEnabled,
      ...(!requestedDryRun && !deps.wms.writesEnabled ? { note: "Forced dry run: Mintsoft writes are off (the MINTSOFT_WRITES_ENABLED master and the admin-page toggle must both be on)" } : {}),
      outcome,
    });
  } catch (err) {
    if (err instanceof ImportConfigError) return errorJson(400, err.code, err.message);
    if (err instanceof ImportHaltedError) return errorJson(500, "import_halted", err.message);
    if (err instanceof HttpError) return errorJson(502, err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", err.message);
    throw err;
  }
};

/** GET /admin/errors?unresolved=1&limit=100 */
export const listErrorsHandler: Handler = async ({ env, url }) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "100") || 100, 1), 500);
  return json({ errors: await listErrors(env.DB, { unresolvedOnly: url.searchParams.get("unresolved") === "1", limit }) });
};

/** POST /admin/errors/:id/resolve */
export const resolveErrorHandler: Handler = async ({ env, params, actor }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return errorJson(400, "invalid_input", "id must be a positive integer");
  if (!(await resolveError(env.DB, id))) return errorJson(404, "error_not_found");
  await audit(env.DB, actor ?? "unknown", "error.resolve", String(id));
  return json({ ok: true, id });
};

/** POST /admin/reconcile — run reconcile now (same as the 5-minute cron). Writes to Wix only. */
export const reconcileHandler: Handler = async ({ env, actor }) => {
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;
  try {
    const report = await reconcileOnce(deps, await listActiveClients(env.DB));
    if (report.results.length) await audit(env.DB, actor ?? "unknown", "reconcile.run", `${report.results.length} despatch(es) pushed`);
    return json({ ...report, subrequestsLeft: deps.budget.remaining });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(502, err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", err.message);
    throw err;
  }
};

/** GET /admin/clients — never returns keys or webhook tokens. */
export const listClientsHandler: Handler = async ({ env }) => {
  return json({ clients: (await listClients(env.DB)).map(toPublicClient) });
};

/** PUT /admin/clients/:slug/courier-map  body: { mappings: [{ wix_shipping_title, mintsoft_courier_service_id, carrier_display_name? }] } */
export const putCourierMapHandler: Handler = async ({ request, env, params, actor }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  const body = await readJsonObject(request);
  const list = body?.mappings;
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
    return errorJson(400, "invalid_input", "mappings must be a non-empty array (max 50)");
  }
  let rules: CourierRule[];
  try {
    rules = list.map((m: unknown, i) => {
      if (!m || typeof m !== "object") throw new BadInput(`mappings[${i}] must be an object`);
      const o = m as Record<string, unknown>;
      return {
        wixShippingTitle: str(o, "wix_shipping_title", { required: true })!,
        mintsoftCourierServiceId: posInt(o, "mintsoft_courier_service_id", { required: true })!,
        carrierDisplayName: str(o, "carrier_display_name"),
      };
    });
  } catch (err) {
    if (err instanceof BadInput) return errorJson(400, "invalid_input", err.message);
    throw err;
  }
  await upsertCourierRules(env.DB, client.id, rules);
  await audit(env.DB, actor ?? "unknown", "courier_map.update", `${client.slug}: ${rules.map((r) => `${r.wixShippingTitle}→${r.mintsoftCourierServiceId}`).join(", ")}`);
  return json({ client: client.slug, mappings: await listCourierRules(env.DB, client.id) });
};

/**
 * POST /admin/clients/:slug/import-products?dryRun=true|false&cursor=…&maxCreates=N
 * One page of Wix variants per call; loop with `nextCursor` until `done` (scripts/import-products.sh).
 * Defaults to a DRY RUN. dryRun=false only takes effect when MINTSOFT_WRITES_ENABLED=true.
 */
export const importProductsHandler: Handler = async ({ env, params, url, actor }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  if (!client.active) return errorJson(409, "client_inactive", `Client ${client.slug} is inactive`);

  const maxCreatesRaw = url.searchParams.get("maxCreates");
  const maxCreates = maxCreatesRaw == null ? undefined : Number(maxCreatesRaw);
  if (maxCreates !== undefined && (!Number.isInteger(maxCreates) || maxCreates < 1)) {
    return errorJson(400, "invalid_input", "maxCreates must be a positive integer");
  }
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;

  const requestedDryRun = url.searchParams.get("dryRun") !== "false";
  try {
    const report = await importProductsPage(deps, client, {
      cursor: url.searchParams.get("cursor") || null,
      dryRun: requestedDryRun,
      ...(maxCreates !== undefined ? { maxCreates } : {}),
    });
    if (!report.dryRun && report.created.length) {
      await audit(env.DB, actor ?? "unknown", "products.import", `${client.slug}: created ${report.created.map((c) => c.sku).join(", ")}`);
    }
    return json({
      ...report,
      ...(report.dryRun && !requestedDryRun ? { note: "Forced dry run: Mintsoft writes are off (the MINTSOFT_WRITES_ENABLED master and the admin-page toggle must both be on)" } : {}),
      subrequestsLeft: deps.budget.remaining,
    });
  } catch (err) {
    if (err instanceof ImportConfigError) return errorJson(400, err.code, err.message);
    if (err instanceof ImportHaltedError) return errorJson(500, "import_halted", err.message);
    if (err instanceof HttpError) return errorJson(502, err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", err.message);
    throw err;
  }
};

/**
 * POST /admin/clients/:slug/run-import?dryRun=true|false
 * Defaults to a DRY RUN. dryRun=false only takes effect when MINTSOFT_WRITES_ENABLED=true.
 * Dry-run responses include the would-be Mintsoft payloads (personal data) — admin only, never logged.
 */
export const runImportHandler: Handler = async ({ env, params, url, actor }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  if (!client.active) return errorJson(409, "client_inactive", `Client ${client.slug} is inactive`);
  const deps = await withDeps(env);
  if (deps instanceof Response) return deps;

  const requestedDryRun = url.searchParams.get("dryRun") !== "false";
  try {
    const report = await importOrdersForClient(deps, client, { limit: maxOrdersPerRun(env), dryRun: requestedDryRun });
    if (!report.dryRun) {
      const summary = report.outcomes.map((o) => `${o.wixOrderNumber}:${o.outcome}`).join(", ") || "nothing new";
      await audit(env.DB, actor ?? "unknown", "orders.import", `${client.slug}: ${summary}`);
    }
    return json({
      ...report,
      ...(report.dryRun && !requestedDryRun ? { note: "Forced dry run: Mintsoft writes are off (the MINTSOFT_WRITES_ENABLED master and the admin-page toggle must both be on)" } : {}),
      subrequestsLeft: deps.budget.remaining,
    });
  } catch (err) {
    if (err instanceof ImportConfigError) return errorJson(400, err.code, err.message);
    if (err instanceof ImportHaltedError) return errorJson(500, "import_halted", err.message);
    if (err instanceof HttpError) return errorJson(502, err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", err.message);
    throw err;
  }
};

/** GET /admin/state — everything the admin page needs on load. No personal data. */
export const stateHandler: Handler = async ({ env, actor }) => {
  const [writes, clients, counts, lastRuns, unresolved] = await Promise.all([
    mintsoftWritesState(env),
    listClients(env.DB),
    countOrdersByStatus(env.DB),
    listSettings(env.DB, "last_run:"),
    listErrors(env.DB, { unresolvedOnly: true, limit: 500 }),
  ]);
  return json({
    user: actor ?? null,
    writes,
    allowedClientIds: [...allowedMintsoftClientIds(env)],
    warehouseId: mintsoftWarehouseId(env),
    accessConfigured: accessConfig(env) !== null,
    unresolvedErrors: unresolved.length,
    lastRuns: Object.fromEntries(Object.entries(lastRuns).map(([k, v]) => [k.slice("last_run:".length), { at: v.updatedAt, summary: safeJson(v.value) }])),
    clients: clients.map((c) => ({
      ...toPublicClient(c),
      orderCounts: Object.fromEntries(counts.filter((x) => x.clientId === c.id).map((x) => [x.status, x.n])),
    })),
  });
};

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** PUT /admin/settings/writes  body: { enabled: boolean } — the admin-page writes toggle. */
export const setWritesHandler: Handler = async ({ request, env, actor }) => {
  const body = await readJsonObject(request);
  if (typeof body?.enabled !== "boolean") return errorJson(400, "invalid_input", "enabled must be true or false");
  const state = await mintsoftWritesState(env);
  if (body.enabled && !state.master) {
    return errorJson(409, "master_off", "MINTSOFT_WRITES_ENABLED (deploy-level master) is not \"true\", so writes can't be switched on from the page");
  }
  const who = actor ?? "unknown";
  await env.DB.batch([
    setSettingStatement(env.DB, "mintsoft_writes", body.enabled ? "on" : "off", who),
    auditStatement(env.DB, who, body.enabled ? "writes.on" : "writes.off", `allowlist ${[...allowedMintsoftClientIds(env)].join(",")}`),
  ]);
  log.warn("admin.writes_toggled", { actor: who, enabled: body.enabled });
  return json({ writes: await mintsoftWritesState(env) });
};

/** GET /admin/clients/:slug/orders?status=held&limit=50 */
export const listOrdersHandler: Handler = async ({ env, params, url }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  const status = url.searchParams.get("status");
  const allowed = ["imported", "held", "skipped_non_physical", "despatched", "fulfilled", "fulfil_failed"];
  if (status && !allowed.includes(status)) return errorJson(400, "invalid_input", `status must be one of ${allowed.join(", ")}`);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 200);
  const orders = await listOrderMaps(env.DB, client.id, { status: (status as OrderStatus | null) ?? null, limit });
  return json({ orders: orders.map(({ clientId: _c, ...o }) => o) });
};

/** GET /admin/clients/:slug/courier-map */
export const getCourierMapHandler: Handler = async ({ env, params }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  return json({ client: client.slug, defaultCourierServiceId: client.defaultCourierServiceId, mappings: await listCourierRules(env.DB, client.id) });
};

/** GET /admin/audit?limit=100 */
export const auditHandler: Handler = async ({ env, url }) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "100") || 100, 1), 500);
  return json({ entries: await listAudit(env.DB, limit) });
};
