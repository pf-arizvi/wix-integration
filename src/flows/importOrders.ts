/**
 * F1: paid, unfulfilled Wix orders → Mintsoft (SPEC §6.1). Cron every 5 min.
 * Batch-capped by MAX_ORDERS_PER_RUN across all clients; leftovers next run.
 * Idempotent via order_map; never partially imports an order.
 */
import type { Env } from "../env";
import { log } from "../lib/log";

export async function runImportOrders(_env: Env, _ctx: ExecutionContext): Promise<void> {
  // TODO(Phase 1)
  log.info("flow.not_implemented", { flow: "importOrders" });
}
