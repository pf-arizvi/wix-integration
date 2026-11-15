/**
 * F3: despatched in Mintsoft but not fulfilled in Wix → pushTracking (SPEC §6.5). Cron hourly.
 * Also retries fulfil_failed rows up to MAX_AUTO_ATTEMPTS.
 */
import type { Env } from "../env";
import { log } from "../lib/log";

export async function runReconcile(_env: Env, _ctx: ExecutionContext): Promise<void> {
  // TODO(Phase 3)
  log.info("flow.not_implemented", { flow: "reconcile" });
}
