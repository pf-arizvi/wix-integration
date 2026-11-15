/**
 * F1: paid, unfulfilled Wix orders → Mintsoft (SPEC §6.1). Cron every 5 min.
 *
 * Per order (never partial):
 *   validate → resolve courier → map → already in Mintsoft? → all SKUs exist?
 *   → [dry run stops here] → create (guarded) → read back and confirm ClientId.
 *
 * Idempotent: order_map skips handled orders; an exact OrderNumber search in
 * Mintsoft (filtered to the client) catches orders created by an earlier attempt
 * whose response was lost.
 *
 * Dry run (MINTSOFT_WRITES_ENABLED != "true", or ?dryRun): NO writes anywhere —
 * not Mintsoft, not order_map, not error_log, not the cursor.
 */
import type { MintsoftNewOrder, MintsoftOrder } from "../adapters/mintsoft/types";
import { MintsoftWriteBlockedError } from "../adapters/mintsoft/client";
import type { WixOrder } from "../adapters/wix/types";
import {
  callsToImportOrder,
  MAX_AUTO_ATTEMPTS,
  maxOrdersPerRun,
  mintsoftWritesEnabled,
  ORDERS_CURSOR_OVERLAP_MS,
  WIX_ORDER_PAGE_SIZE,
} from "../config";
import { type ClientRecord, deactivateClient, listActiveClients } from "../db/clients";
import { listCourierRules } from "../db/courierMap";
import { recordError } from "../db/errors";
import { getOrderMapsByWixIds, saveOrderOutcome } from "../db/orderMap";
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
  | { wixOrderNumber: string; outcome: "imported"; mintsoftOrderId: number; warehouseId?: number; channelId?: number }
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
        if (row && (row.status !== "held" || row.attempts >= MAX_AUTO_ATTEMPTS)) {
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
        report.outcomes.push(await processOrder(deps, client, order, rules, urls, warehouseId, dryRun));
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

async function processOrder(
  deps: FlowDeps,
  client: ClientRecord,
  order: WixOrder,
  rules: readonly CourierRule[],
  urls: WebhookUrls,
  warehouseId: number,
  dryRun: boolean,
): Promise<OrderOutcome> {
  const num = order.number;
  const msClientId = client.mintsoftClientId;
  const base = { clientId: client.id, wixOrderId: order.id, wixOrderNumber: num };

  const hold = async (code: ErrorCode, message: string, mintsoftOrderId?: number): Promise<OrderOutcome> => {
    if (!dryRun) {
      await saveOrderOutcome(deps.db, {
        ...base,
        status: "held",
        mintsoftOrderId: mintsoftOrderId ?? null,
        lastError: message,
        countAttempt: true,
        error: { clientId: client.id, flow: "importOrders", ref: num, code, message },
      });
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
    if (missing.length) {
      return hold("unknown_sku", `Order ${num} held: SKU ${missing.join(", ")} not found in Mintsoft client ${msClientId}`);
    }

    if (dryRun) return { wixOrderNumber: num, outcome: "would_import", payload };

    // 3. Create. The adapter re-checks writes-enabled + ClientId allowlist before sending.
    const res = await deps.wms.createOrder(payload);
    if (!res.Success || !res.OrderId) {
      const msg = res.Message?.trim() || "no message";
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
}
