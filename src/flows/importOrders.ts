/**
 * F1: paid, unfulfilled Wix orders → Mintsoft (SPEC §6.1). Cron every 5 min.
 *
 * Per order (never partial):
 *   validate → resolve courier → map → already in Mintsoft? → all SKUs exist?
 *   → [dry run stops here] → create (guarded) → read back and confirm ClientId.
 *
 * Unknown SKU (agreed): the order is held, AND sent to Mintsoft once anyway so Mintsoft rejects
 * it and raises its own connect error where the warehouse team looks. Automatic retries don't
 * re-send (mintsoft_notified_at); a manual retry can. If Mintsoft unexpectedly ACCEPTS it, that's
 * flagged straight away (mintsoft_accepted_unknown_sku) with the lines Mintsoft created.
 *
 * Held orders are retried by retryHeldOrders (hourly per order, for 7 days) and on demand
 * (POST /admin/clients/:slug/orders/:wixOrderNumber/retry). The main search skips them.
 *
 * Idempotent: order_map skips handled orders; an exact OrderNumber search in
 * Mintsoft (filtered to the client) catches orders created by an earlier attempt
 * whose response was lost.
 *
 * Dry run (MINTSOFT_WRITES_ENABLED != "true", or ?dryRun): NO writes anywhere —
 * not Mintsoft, not order_map, not error_log, not the cursor.
 */
import type { MintsoftNewOrder, MintsoftOrder } from "../adapters/mintsoft/types";
import { alertHeldOrder, alertNeedsAttention } from "./alerts";
import { MintsoftWriteBlockedError } from "../adapters/mintsoft/client";
import type { WixOrder } from "../adapters/wix/types";
import {
  callsToImportOrder,
  HELD_RETRIES_PER_RUN,
  HELD_RETRY_INTERVAL_MINUTES,
  HELD_RETRY_MAX_DAYS,
  maxOrdersPerRun,
  mintsoftWritesEnabled,
  ORDERS_CURSOR_OVERLAP_MS,
  WIX_ORDER_PAGE_SIZE,
} from "../config";
import { type ClientRecord, deactivateClient, listActiveClients } from "../db/clients";
import { listCourierRules } from "../db/courierMap";
import { recordError } from "../db/errors";
import { getOrderMapsByWixIds, listHeldForRetry, type OrderMapRecord, saveOrderOutcome, touchOrderMap } from "../db/orderMap";
import { getSyncState, setSyncState } from "../db/syncState";
import type { Env } from "../env";
import type { ErrorCode } from "../errorCodes";
import { HttpError } from "../lib/http";
import { log } from "../lib/log";
import { webhookUrls, type WebhookUrls } from "../lib/webhookUrls";
import { type CourierRule, resolveCourier } from "../mapping/courierMap";
import { mapWixOrderToMintsoft } from "../mapping/orderMapper";
import { validateWixOrder } from "../mapping/validation";
import { createFlowDeps } from "./deps";
import { ImportConfigError, ImportHaltedError } from "./errors";
import type { FlowDeps } from "./ports";

export { ImportConfigError, ImportHaltedError };

export type OrderOutcome =
  | { wixOrderNumber: string; outcome: "imported"; mintsoftOrderId: number; warehouseId?: number; channelId?: number; warning?: string }
  | { wixOrderNumber: string; outcome: "already_in_mintsoft"; mintsoftOrderId: number }
  | { wixOrderNumber: string; outcome: "would_import"; payload: MintsoftNewOrder }
  | { wixOrderNumber: string; outcome: "held"; code: ErrorCode; message: string }
  | { wixOrderNumber: string; outcome: "skipped_non_physical" }
  | { wixOrderNumber: string; outcome: "skipped"; reason: string };

export interface ClientImportReport {
  client: string;
  dryRun: boolean;
  ordersSeen: number;
  alreadyHandled: number;
  processed: number;
  outcomes: OrderOutcome[];
  cursorFrom: string;
  /** New orders_cursor (null = unchanged; always null in dry run). */
  cursorTo: string | null;
  stoppedBy: "order_cap" | "subrequest_budget" | null;
}

export interface ImportOptions {
  /** Max orders to process (not counting already-handled ones). */
  limit: number;
  dryRun: boolean;
}

export async function importOrdersForClient(deps: FlowDeps, client: ClientRecord, opts: ImportOptions): Promise<ClientImportReport> {
  const dryRun = opts.dryRun || !deps.wms.writesEnabled;

  if (!deps.wms.allowedClientIds.has(client.mintsoftClientId)) {
    throw new ImportConfigError(
      "mintsoft_client_not_allowed",
      `Client ${client.slug}: Mintsoft ClientId ${client.mintsoftClientId} is not in MINTSOFT_ALLOWED_CLIENT_IDS`,
    );
  }
  if (!deps.workerBaseUrl) {
    throw new ImportConfigError("config_error", "WORKER_BASE_URL is not set; cannot register despatch webhooks");
  }
  const warehouseId = deps.mintsoftWarehouseId;
  if (warehouseId == null) {
    throw new ImportConfigError("config_error", "MINTSOFT_WAREHOUSE_ID is not set to a valid number; Mintsoft requires a WarehouseId on every order");
  }

  const cursorFrom = (await getSyncState(deps.db, client.id, "orders_cursor")) ?? client.createdAt;
  const since = new Date(Date.parse(cursorFrom) - ORDERS_CURSOR_OVERLAP_MS).toISOString();
  const rules = await listCourierRules(deps.db, client.id);
  const source = await deps.orderSourceFor(client);
  const urls = webhookUrls(deps.workerBaseUrl, client.slug, client.webhookToken);

  const report: ClientImportReport = {
    client: client.slug,
    dryRun,
    ordersSeen: 0,
    alreadyHandled: 0,
    processed: 0,
    outcomes: [],
    cursorFrom,
    cursorTo: null,
    stoppedBy: null,
  };
  let lastHandledUpdated: string | null = null;
  const markHandled = (o: WixOrder) => {
    if (o.updatedDate && (!lastHandledUpdated || Date.parse(o.updatedDate) > Date.parse(lastHandledUpdated))) {
      lastHandledUpdated = o.updatedDate;
    }
  };

  let pageCursor: string | null = null;
  try {
    outer: while (true) {
      if (!deps.budget.has(1)) {
        report.stoppedBy = "subrequest_budget";
        break;
      }
      const page = await source.searchPaidUnfulfilled({ updatedSince: since, limit: WIX_ORDER_PAGE_SIZE, cursor: pageCursor });
      report.ordersSeen += page.orders.length;
      const known = await getOrderMapsByWixIds(
        deps.db,
        client.id,
        page.orders.map((o) => o.id),
      );

      for (const order of page.orders) {
        const row = known.get(order.id);
        // Already recorded (imported, held, skipped…). Held orders are retried by retryHeldOrders.
        if (row) {
          report.alreadyHandled++;
          markHandled(order);
          continue;
        }
        if (report.processed >= opts.limit) {
          report.stoppedBy = "order_cap";
          break outer;
        }
        if (!deps.budget.has(callsToImportOrder(distinctSkus(order).length))) {
          report.stoppedBy = "subrequest_budget";
          break outer;
        }
        report.outcomes.push(await processOrder(deps, client, order, { rules, urls, warehouseId, dryRun, previous: null, forceNotify: false }));
        report.processed++;
        markHandled(order);
      }

      if (!page.nextCursor || page.orders.length === 0) break;
      pageCursor = page.nextCursor;
    }
  } catch (err) {
    if (err instanceof HttpError && err.kind === "budget_exhausted") report.stoppedBy = "subrequest_budget";
    else throw err;
  }

  // Advance only to the newest order actually handled — never past one left for the next run.
  if (!dryRun && lastHandledUpdated && Date.parse(lastHandledUpdated) > Date.parse(cursorFrom)) {
    await setSyncState(deps.db, client.id, "orders_cursor", lastHandledUpdated);
    report.cursorTo = lastHandledUpdated;
  }
  return report;
}

interface ProcessContext {
  rules: readonly CourierRule[];
  urls: WebhookUrls;
  warehouseId: number;
  dryRun: boolean;
  /** Existing order_map row (retries), null for a first attempt. */
  previous: OrderMapRecord | null;
  /** Re-send an unknown-SKU order to Mintsoft even if it was already sent once (manual retry). */
  forceNotify: boolean;
}

async function processOrder(deps: FlowDeps, client: ClientRecord, order: WixOrder, pc: ProcessContext): Promise<OrderOutcome> {
  const { rules, urls, warehouseId, dryRun, previous } = pc;
  const num = order.number;
  const msClientId = client.mintsoftClientId;
  const base = { clientId: client.id, wixOrderId: order.id, wixOrderNumber: num };

  const hold = async (code: ErrorCode, message: string, o: { mintsoftOrderId?: number; markNotified?: boolean } = {}): Promise<OrderOutcome> => {
    if (!dryRun) {
      await saveOrderOutcome(deps.db, {
        ...base,
        status: "held",
        mintsoftOrderId: o.mintsoftOrderId ?? null,
        lastError: message,
        countAttempt: true,
        markNotified: o.markNotified ?? false,
        error: { clientId: client.id, flow: "importOrders", ref: num, code, message },
      });
      // Alert once, when the order first becomes held (not on every retry).
      if (previous?.status !== "held") await alertHeldOrder({ client: client.slug, wixOrderNumber: num, code, message });
    }
    log.warn("importOrders.held", { client: client.slug, order: num, code });
    return { wixOrderNumber: num, outcome: "held", code, message };
  };

  const v = validateWixOrder(order);
  if (v.kind === "skip") return { wixOrderNumber: num, outcome: "skipped", reason: v.reason };
  if (v.kind === "non_physical") {
    if (!dryRun) await saveOrderOutcome(deps.db, { ...base, status: "skipped_non_physical", countAttempt: false });
    return { wixOrderNumber: num, outcome: "skipped_non_physical" };
  }
  if (v.kind === "hold") return hold(v.code, v.message);

  const courier = resolveCourier(order, rules, {
    courierServiceId: client.defaultCourierServiceId,
    carrierName: client.defaultCarrierName,
  });
  if (!courier) {
    return hold(
      "unmapped_courier",
      `Order ${num} held: shipping method "${order.shippingInfo?.title ?? "(none)"}" has no courier mapping and client ${client.slug} has no default courier`,
    );
  }

  const payload = mapWixOrderToMintsoft(order, v.lines, {
    mintsoftClientId: msClientId,
    mintsoftWarehouseId: warehouseId,
    orderNumberPrefix: client.orderNumberPrefix,
    courierServiceId: courier.courierServiceId,
    despatchWebhookUrl: urls.despatch,
    cancelWebhookUrl: urls.cancel,
  });

  try {
    // 1. Already in Mintsoft for THIS client? (lost response on an earlier attempt, re-run, etc.)
    const existing = await deps.wms.findOrdersByNumber(payload.OrderNumber, msClientId);
    if (existing[0]) {
      const id = existing[0].ID;
      if (!dryRun) await saveOrderOutcome(deps.db, { ...base, status: "imported", mintsoftOrderId: id, countAttempt: true });
      log.info("importOrders.already_in_mintsoft", { client: client.slug, order: num, mintsoftOrderId: id });
      return { wixOrderNumber: num, outcome: "already_in_mintsoft", mintsoftOrderId: id };
    }

    // 2. Every SKU must exist for this Mintsoft client — never partially import.
    const missing: string[] = [];
    for (const sku of distinctSkus(order, v.lines)) {
      if ((await deps.wms.lookupProductId(sku, msClientId)) == null) missing.push(sku);
    }
    const reason = `SKU ${missing.join(", ")} not found in Mintsoft client ${msClientId}`;
    const notifyMintsoft = missing.length > 0 && (pc.forceNotify || !previous?.mintsoftNotifiedAt);
    if (missing.length && !notifyMintsoft) return hold("unknown_sku", `Order ${num} held: ${reason}`);
    if (missing.length && dryRun) {
      return hold("unknown_sku", `Order ${num} held: ${reason} (a real run sends it to Mintsoft once so Mintsoft raises a connect error)`);
    }
    if (dryRun) return { wixOrderNumber: num, outcome: "would_import", payload };

    // 3. Create. The adapter re-checks writes-enabled + ClientId allowlist before sending.
    //    With unknown SKUs this is sent ONLY so Mintsoft rejects it and shows its connect error.
    const res = await deps.wms.createOrder(payload);
    if (!res.Success || !res.OrderId) {
      const msg = res.Message?.trim() || "no message";
      if (missing.length) {
        return hold("unknown_sku", `Order ${num} held: ${reason}. Sent to Mintsoft to raise its connect error; Mintsoft replied: ${msg}`, {
          markNotified: true,
        });
      }
      return hold(/sku|product/i.test(msg) ? "unknown_sku" : "mintsoft_rejected", `Order ${num} held: Mintsoft rejected the order: ${msg}`);
    }
    const mintsoftOrderId = res.OrderId;

    // 4. Read back and confirm it landed on the right client.
    let created: MintsoftOrder;
    try {
      created = await deps.wms.getOrder(mintsoftOrderId);
    } catch (err) {
      if (err instanceof HttpError && err.kind === "budget_exhausted") throw err;
      const message = `Order ${num} created as Mintsoft order ${mintsoftOrderId} but could not be read back to verify ClientId: ${errMessage(err)}`;
      await saveOrderOutcome(deps.db, {
        ...base,
        status: "imported",
        mintsoftOrderId,
        countAttempt: true,
        error: { clientId: client.id, flow: "importOrders", ref: num, code: "mintsoft_verify_failed", message },
      });
      log.warn("importOrders.verify_failed", { client: client.slug, order: num, mintsoftOrderId });
      return { wixOrderNumber: num, outcome: "imported", mintsoftOrderId };
    }

    if (created.ClientId !== msClientId) {
      const message =
        `Order ${num} was created as Mintsoft order ${mintsoftOrderId} but Mintsoft reports ClientId ${String(created.ClientId)} ` +
        `(expected ${msClientId}). Client ${client.slug} has been deactivated and all imports halted. Check Mintsoft immediately.`;
      await saveOrderOutcome(deps.db, {
        ...base,
        status: "held",
        mintsoftOrderId,
        lastError: message,
        countAttempt: true,
        error: { clientId: client.id, flow: "importOrders", ref: num, code: "mintsoft_client_mismatch", message },
      });
      await deactivateClient(deps.db, client.id);
      log.error("importOrders.client_mismatch", { client: client.slug, order: num, mintsoftOrderId, reportedClientId: created.ClientId });
      throw new ImportHaltedError(message);
    }

    if (missing.length) {
      // Mintsoft accepted an order we know has unknown SKUs: possibly a partial import. Flag it now.
      let lines = "unknown";
      try {
        lines = (await deps.wms.getOrderItems(mintsoftOrderId)).map((i) => `${i.SKU ?? "?"} × ${i.Quantity ?? "?"}`).join(", ") || "none";
      } catch (err) {
        if (err instanceof HttpError && err.kind === "budget_exhausted") throw err;
      }
      const warning =
        `Order ${num}: Mintsoft ACCEPTED it as order ${mintsoftOrderId} although ${reason}. ` +
        `Mintsoft order lines: ${lines}. Wix lines: ${v.lines.map((l) => `${l.physicalProperties?.sku} × ${l.quantity}`).join(", ")}. Check the order in Mintsoft.`;
      await saveOrderOutcome(deps.db, {
        ...base,
        status: "imported",
        mintsoftOrderId,
        countAttempt: true,
        markNotified: true,
        error: { clientId: client.id, flow: "importOrders", ref: num, code: "mintsoft_accepted_unknown_sku", message: warning },
      });
      await alertNeedsAttention({ client: client.slug, wixOrderNumber: num, code: "mintsoft_accepted_unknown_sku", message: warning });
      return { wixOrderNumber: num, outcome: "imported", mintsoftOrderId, warning };
    }

    await saveOrderOutcome(deps.db, { ...base, status: "imported", mintsoftOrderId, countAttempt: true });
    log.info("importOrders.imported", {
      client: client.slug,
      order: num,
      mintsoftOrderId,
      warehouseId: created.WarehouseId,
      channelId: created.ChannelId,
    });
    return { wixOrderNumber: num, outcome: "imported", mintsoftOrderId, warehouseId: created.WarehouseId, channelId: created.ChannelId };
  } catch (err) {
    if (err instanceof ImportHaltedError) throw err;
    if (err instanceof HttpError && err.kind === "budget_exhausted") throw err;
    if (err instanceof MintsoftWriteBlockedError) return hold(err.code, `Order ${num} held: ${err.message}`);
    if (err instanceof HttpError) return hold("mintsoft_api_error", `Order ${num} held: ${err.message}`);
    throw err;
  }
}

/** Shared setup for importing one order outside the main search (retries). */
async function singleOrderContext(deps: FlowDeps, client: ClientRecord) {
  if (!deps.wms.allowedClientIds.has(client.mintsoftClientId)) {
    throw new ImportConfigError("mintsoft_client_not_allowed", `Client ${client.slug}: Mintsoft ClientId ${client.mintsoftClientId} is not allowlisted`);
  }
  if (!deps.workerBaseUrl) throw new ImportConfigError("config_error", "WORKER_BASE_URL is not set");
  if (deps.mintsoftWarehouseId == null) throw new ImportConfigError("config_error", "MINTSOFT_WAREHOUSE_ID is not set to a valid number");
  return {
    rules: await listCourierRules(deps.db, client.id),
    urls: webhookUrls(deps.workerBaseUrl, client.slug, client.webhookToken),
    warehouseId: deps.mintsoftWarehouseId,
    source: await deps.orderSourceFor(client),
  };
}

/**
 * Retry one recorded order now (held orders; manual admin retry). Fetches the current Wix order.
 * `forceNotify` re-sends an unknown-SKU order to Mintsoft so it raises its connect error again.
 */
export async function retryOrder(
  deps: FlowDeps,
  client: ClientRecord,
  row: OrderMapRecord,
  opts: { dryRun: boolean; forceNotify: boolean },
): Promise<OrderOutcome> {
  const dryRun = opts.dryRun || !deps.wms.writesEnabled;
  const ctx = await singleOrderContext(deps, client);
  const order = await ctx.source.getOrder(row.wixOrderId);
  const outcome = await processOrder(deps, client, order, { ...ctx, dryRun, previous: row, forceNotify: opts.forceNotify });
  // Skipped (e.g. now cancelled or unpaid) writes nothing: bump updated_at so the hourly retry backs off.
  if (!dryRun && outcome.outcome === "skipped") await touchOrderMap(deps.db, client.id, row.wixOrderId);
  return outcome;
}

/** Retries held orders due a retry (hourly per order, for 7 days). Runs after the main import. */
export async function retryHeldOrders(deps: FlowDeps, clients: readonly ClientRecord[]): Promise<OrderOutcome[]> {
  const out: OrderOutcome[] = [];
  const rows = await listHeldForRetry(deps.db, {
    minAgeMinutes: HELD_RETRY_INTERVAL_MINUTES,
    maxAgeDays: HELD_RETRY_MAX_DAYS,
    limit: HELD_RETRIES_PER_RUN,
  });
  for (const row of rows) {
    const client = clients.find((c) => c.id === row.clientId);
    if (!client) continue;
    if (!deps.budget.has(1 + callsToImportOrder(3))) break;
    try {
      out.push(await retryOrder(deps, client, row, { dryRun: false, forceNotify: false }));
    } catch (err) {
      if (err instanceof ImportHaltedError) throw err;
      if (err instanceof HttpError && err.kind === "budget_exhausted") break;
      log.warn("importOrders.held_retry_failed", { client: client.slug, order: row.wixOrderNumber, err });
      await touchOrderMap(deps.db, client.id, row.wixOrderId);
    }
  }
  return out;
}

function distinctSkus(order: WixOrder, lines = order.lineItems ?? []): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const sku = l.physicalProperties?.sku?.trim();
    if (sku) out.add(sku);
  }
  return [...out];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cron entry. Skipped entirely while Mintsoft writes are disabled. */
export async function runImportOrders(env: Env, _ctx: ExecutionContext): Promise<void> {
  if (!mintsoftWritesEnabled(env)) {
    log.info("importOrders.skipped", { reason: "MINTSOFT_WRITES_ENABLED is not true" });
    return;
  }
  const deps = createFlowDeps(env);
  let remaining = maxOrdersPerRun(env);

  for (const client of await listActiveClients(env.DB)) {
    if (remaining <= 0 || !deps.budget.has(1)) break;
    try {
      const r = await importOrdersForClient(deps, client, { limit: remaining, dryRun: false });
      remaining -= r.processed;
      log.info("importOrders.client_done", {
        client: client.slug,
        seen: r.ordersSeen,
        alreadyHandled: r.alreadyHandled,
        processed: r.processed,
        imported: r.outcomes.filter((o) => o.outcome === "imported" || o.outcome === "already_in_mintsoft").length,
        held: r.outcomes.filter((o) => o.outcome === "held").length,
        stoppedBy: r.stoppedBy,
        subrequestsLeft: deps.budget.remaining,
      });
    } catch (err) {
      if (err instanceof ImportHaltedError) throw err; // stop everything; cron run marked failed
      const code: ErrorCode =
        err instanceof ImportConfigError ? err.code : err instanceof HttpError && err.service === "wix" ? "wix_api_error" : "mintsoft_api_error";
      log.error("importOrders.client_failed", { client: client.slug, code, err });
      await recordError(env.DB, { clientId: client.id, flow: "importOrders", ref: null, code, message: errMessage(err) });
    }
  }

  // Held orders (e.g. SKU since added in Mintsoft), with whatever budget is left.
  const retried = await retryHeldOrders(deps, await listActiveClients(env.DB));
  if (retried.length) {
    log.info("importOrders.held_retried", { results: retried.map((r) => ({ order: r.wixOrderNumber, outcome: r.outcome })) });
  }
}
