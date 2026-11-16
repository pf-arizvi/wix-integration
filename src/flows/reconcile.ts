/**
 * F3: reconcile — despatched in Mintsoft but not fulfilled in Wix → pushTracking (SPEC §6.5).
 * Runs every 5 minutes (agreed): it's the MAIN despatch mechanism, because Mintsoft has
 * not been seen to call the ConnectAction URL. The webhook stays as a bonus.
 *
 *   1. One Order/List?SinceDespatchDate query (oldest first, 100/page) covers every client.
 *      Filter client-side to active clients' Mintsoft ClientIds (warehouse keys ignore ClientId).
 *   2. Act only on orders WE imported (order_map match); other channels' orders are ignored.
 *   3. Same handling as the webhook (handleDespatch): splits, untracked, idempotency, guards.
 *   4. Retry failed fulfilments (attempts < 5).
 *   5. Advance each client's reconcile_since to the newest DespatchDate fully processed.
 *
 * Writes only to Wix and D1 — never Mintsoft.
 */
import type { MintsoftOrder } from "../adapters/mintsoft/types";
import { CALLS_PER_DESPATCH, MAX_AUTO_ATTEMPTS, RECONCILE_MAX_PAGES, RECONCILE_MAX_RETRIES, RECONCILE_OVERLAP_MS } from "../config";
import { type ClientRecord, listActiveClients } from "../db/clients";
import { getFulfilment, listRetryableFulfilments } from "../db/fulfilments";
import { getSyncState, setSyncState } from "../db/syncState";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { log } from "../lib/log";
import { parseDespatchPayload } from "../mapping/trackingMapper";
import { createFlowDeps } from "./deps";
import type { FlowDeps } from "./ports";
import { type DespatchOutcome, findOrderRow, handleDespatch } from "./pushTracking";

export interface ReconcileReport {
  since: string | null;
  pagesRead: number;
  despatchedSeen: number;
  ours: number;
  results: (DespatchOutcome & { mintsoftOrderId: number; source: "despatched" | "retry" })[];
  cursorTo: string | null;
  stoppedBy: "page_cap" | "subrequest_budget" | null;
}

/** Mintsoft dates are zone-less; keep them zone-less ("YYYY-MM-DDTHH:mm:ss"). */
export function toMintsoftDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function parseDate(s: string | undefined | null): number {
  if (!s) return NaN;
  // Zone-less values are treated as UTC consistently on both sides of the comparison.
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export async function reconcileOnce(deps: FlowDeps, clients: readonly ClientRecord[]): Promise<ReconcileReport> {
  const report: ReconcileReport = { since: null, pagesRead: 0, despatchedSeen: 0, ours: 0, results: [], cursorTo: null, stoppedBy: null };
  if (!clients.length) return report;
  const byMintsoftId = new Map(clients.map((c) => [c.mintsoftClientId, c]));

  // Window start: the oldest client cursor, minus the overlap.
  const cursors = await Promise.all(clients.map(async (c) => (await getSyncState(deps.db, c.id, "reconcile_since")) ?? c.createdAt));
  const fromMs = Math.min(...cursors.map(parseDate).filter(Number.isFinite)) - RECONCILE_OVERLAP_MS;
  report.since = toMintsoftDate(fromMs);

  let newest: number | null = null;
  try {
    pages: for (let page = 1; page <= RECONCILE_MAX_PAGES; page++) {
      if (!deps.budget.has(1)) {
        report.stoppedBy = "subrequest_budget";
        break;
      }
      const orders = await deps.wms.listDespatchedSince(report.since, page);
      report.pagesRead++;
      report.despatchedSeen += orders.length;

      for (const o of orders) {
        const outcome = await reconcileOne(deps, byMintsoftId, o, report);
        if (outcome === "out_of_budget") {
          report.stoppedBy = "subrequest_budget";
          break pages;
        }
        const t = parseDate(o.DespatchDate);
        if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
      }
      if (orders.length < 100) break;
      if (page === RECONCILE_MAX_PAGES) report.stoppedBy = "page_cap";
    }

    // Retry failed fulfilments (e.g. Wix was down), with whatever budget is left.
    for (const f of await listRetryableFulfilments(deps.db, MAX_AUTO_ATTEMPTS, RECONCILE_MAX_RETRIES)) {
      const client = clients.find((c) => c.id === f.clientId);
      if (!client || !deps.budget.has(1 + CALLS_PER_DESPATCH)) break;
      const order = await deps.wms.getOrder(f.mintsoftOrderId);
      report.results.push({ ...(await handleDespatch(deps, client, order)), mintsoftOrderId: f.mintsoftOrderId, source: "retry" });
    }
  } catch (err) {
    if (!(err instanceof HttpError && err.kind === "budget_exhausted")) throw err;
    report.stoppedBy = "subrequest_budget";
  }

  if (newest !== null) {
    report.cursorTo = toMintsoftDate(newest);
    await Promise.all(clients.map((c) => setSyncState(deps.db, c.id, "reconcile_since", report.cursorTo!)));
  }
  return report;
}

async function reconcileOne(
  deps: FlowDeps,
  byMintsoftId: Map<number, ClientRecord>,
  o: MintsoftOrder,
  report: ReconcileReport,
): Promise<"skipped" | "done" | "out_of_budget"> {
  const client = o.ClientId != null ? byMintsoftId.get(o.ClientId) : undefined;
  if (!client) return "skipped"; // another 3PL client's order

  const d = parseDespatchPayload(o);
  const row = await findOrderRow(deps, client, d);
  if (!row) return "skipped"; // this client's order from another channel — not ours
  report.ours++;
  if (row.status === "fulfilled") return "skipped";
  if (d.mintsoftOrderId != null && (await getFulfilment(deps.db, client.id, d.mintsoftOrderId))?.status === "created") return "skipped";

  if (!deps.budget.has(CALLS_PER_DESPATCH)) return "out_of_budget";
  const outcome = await handleDespatch(deps, client, o);
  report.results.push({ ...outcome, mintsoftOrderId: o.ID, source: "despatched" });
  return "done";
}

/** Cron entry (every 5 minutes, offset from the import). */
export async function runReconcile(env: Env, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const clients = await listActiveClients(env.DB);
  if (!clients.length) return { clients: 0 };
  const deps = await createFlowDeps(env);
  const r = await reconcileOnce(deps, clients);
  log.info("reconcile.done", {
    since: r.since,
    pages: r.pagesRead,
    despatchedSeen: r.despatchedSeen,
    ours: r.ours,
    pushed: r.results.length,
    errors: r.results.filter((x) => x.outcome === "error").length,
    cursorTo: r.cursorTo,
    stoppedBy: r.stoppedBy,
    subrequestsLeft: deps.budget.remaining,
  });
  return {
    despatchedSeen: r.despatchedSeen,
    pushed: r.results.filter((x) => x.outcome !== "error").length,
    errors: r.results.filter((x) => x.outcome === "error").length,
    stoppedBy: r.stoppedBy,
  };
}
