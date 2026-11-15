/**
 * Admin JSON endpoints (Bearer ADMIN_TOKEN, applied in index.ts via adminOnly).
 * Handlers validate input and delegate to flows / db. No business logic here.
 */
import { maxOrdersPerRun } from "../config";
import { getClientBySlug, listClients, toPublicClient } from "../db/clients";
import { listCourierRules, upsertCourierRules } from "../db/courierMap";
import { createFlowDeps } from "../flows/deps";
import { ImportConfigError, ImportHaltedError, importOrdersForClient } from "../flows/importOrders";
import { importProductsPage } from "../flows/importProducts";
import { inspectCourierMappings } from "../flows/inspectCouriers";
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

function withDeps(env: Env): FlowDeps | Response {
  try {
    return createFlowDeps(env);
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
export const createClientHandler: Handler = async ({ request, env }) => {
  const body = await readJsonObject(request);
  if (!body) return errorJson(400, "invalid_json", "Body must be a JSON object");
  let input: OnboardInput;
  try {
    input = parseOnboardInput(body);
  } catch (err) {
    if (err instanceof BadInput) return errorJson(400, "invalid_input", err.message);
    throw err;
  }
  const deps = withDeps(env);
  if (deps instanceof Response) return deps;
  const result = await onboardClient(deps, input);
  if (!result.ok) return errorJson(result.status, result.error, result.message);
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
  const deps = withDeps(env);
  if (deps instanceof Response) return deps;
  try {
    const result = await inspectCourierMappings(deps, { offset, limit, includeInactive: url.searchParams.get("includeInactive") === "true" });
    return json({ ...result, subrequestsLeft: deps.budget.remaining });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(502, "mintsoft_api_error", err.message);
    throw err;
  }
};

/** GET /admin/clients — never returns keys or webhook tokens. */
export const listClientsHandler: Handler = async ({ env }) => {
  return json({ clients: (await listClients(env.DB)).map(toPublicClient) });
};

/** PUT /admin/clients/:slug/courier-map  body: { mappings: [{ wix_shipping_title, mintsoft_courier_service_id, carrier_display_name? }] } */
export const putCourierMapHandler: Handler = async ({ request, env, params }) => {
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
  return json({ client: client.slug, mappings: await listCourierRules(env.DB, client.id) });
};

/**
 * POST /admin/clients/:slug/import-products?dryRun=true|false&cursor=…&maxCreates=N
 * One page of Wix variants per call; loop with `nextCursor` until `done` (scripts/import-products.sh).
 * Defaults to a DRY RUN. dryRun=false only takes effect when MINTSOFT_WRITES_ENABLED=true.
 */
export const importProductsHandler: Handler = async ({ env, params, url }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  if (!client.active) return errorJson(409, "client_inactive", `Client ${client.slug} is inactive`);

  const maxCreatesRaw = url.searchParams.get("maxCreates");
  const maxCreates = maxCreatesRaw == null ? undefined : Number(maxCreatesRaw);
  if (maxCreates !== undefined && (!Number.isInteger(maxCreates) || maxCreates < 1)) {
    return errorJson(400, "invalid_input", "maxCreates must be a positive integer");
  }
  const deps = withDeps(env);
  if (deps instanceof Response) return deps;

  const requestedDryRun = url.searchParams.get("dryRun") !== "false";
  try {
    const report = await importProductsPage(deps, client, {
      cursor: url.searchParams.get("cursor") || null,
      dryRun: requestedDryRun,
      ...(maxCreates !== undefined ? { maxCreates } : {}),
    });
    return json({
      ...report,
      ...(report.dryRun && !requestedDryRun ? { note: "Forced dry run: MINTSOFT_WRITES_ENABLED is not true" } : {}),
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
export const runImportHandler: Handler = async ({ env, params, url }) => {
  const client = await getClientBySlug(env.DB, params.slug!);
  if (!client) return errorJson(404, "client_not_found");
  if (!client.active) return errorJson(409, "client_inactive", `Client ${client.slug} is inactive`);
  const deps = withDeps(env);
  if (deps instanceof Response) return deps;

  const requestedDryRun = url.searchParams.get("dryRun") !== "false";
  try {
    const report = await importOrdersForClient(deps, client, { limit: maxOrdersPerRun(env), dryRun: requestedDryRun });
    return json({
      ...report,
      ...(report.dryRun && !requestedDryRun ? { note: "Forced dry run: MINTSOFT_WRITES_ENABLED is not true" } : {}),
      subrequestsLeft: deps.budget.remaining,
    });
  } catch (err) {
    if (err instanceof ImportConfigError) return errorJson(400, err.code, err.message);
    if (err instanceof ImportHaltedError) return errorJson(500, "import_halted", err.message);
    if (err instanceof HttpError) return errorJson(502, err.service === "wix" ? "wix_api_error" : "mintsoft_api_error", err.message);
    throw err;
  }
};
