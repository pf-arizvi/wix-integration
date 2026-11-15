/**
 * Worker entry: fetch + scheduled handlers. Routing/dispatch only — no business logic.
 */
import { CRON } from "./config";
import { countClients } from "./db/clients";
import type { Env } from "./env";
import { runImportOrders } from "./flows/importOrders";
import { runReconcile } from "./flows/reconcile";
import { log } from "./lib/log";
import { errorJson, json } from "./lib/response";
import { adminOnly, Router } from "./router";
import {
  courierServicesHandler,
  createClientHandler,
  listCarriersHandler,
  putCarriersHandler,
  importProductsHandler,
  listClientsHandler,
  putCourierMapHandler,
  reconcileHandler,
  runImportHandler,
} from "./routes/admin";
import { cancelWebhookHandler, despatchWebhookHandler } from "./routes/webhooks";
import { purgeWebhookLog } from "./db/webhookLog";

const router = new Router()
  // Unauthenticated liveness probe. Touches nothing, returns no data.
  .get("/healthz", () => json({ ok: true }))
  // Phase 0: proves admin auth + D1 binding + migrations. Expanded in Phase 3 (SPEC §6.7).
  .get(
    "/admin/health",
    adminOnly(async ({ env }) => json({ ok: true, db: { clients: await countClients(env.DB) } })),
  )
  .post("/admin/clients", adminOnly(createClientHandler))
  .get("/admin/clients", adminOnly(listClientsHandler))
  .get("/admin/mintsoft/courier-services", adminOnly(courierServicesHandler))
  .put("/admin/clients/:slug/courier-map", adminOnly(putCourierMapHandler))
  .post("/admin/clients/:slug/import-products", adminOnly(importProductsHandler))
  .post("/admin/clients/:slug/run-import", adminOnly(runImportHandler))
  .post("/admin/reconcile", adminOnly(reconcileHandler))
  .get("/admin/carriers", adminOnly(listCarriersHandler))
  .put("/admin/carriers", adminOnly(putCarriersHandler))
  // Mintsoft webhooks: authenticated by the per-client token in the URL, not the admin token.
  .post("/webhooks/mintsoft/despatch/:slug", despatchWebhookHandler)
  .post("/webhooks/mintsoft/cancel/:slug", cancelWebhookHandler);
// TODO(Phase 3): /admin/clients/:slug/orders/:wixOrderNumber/retry, /admin/errors*, full /admin/health
export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await router.handle(request, env, ctx);
    } catch (err) {
      log.error("http.unhandled", { path: new URL(request.url).pathname, err });
      return errorJson(500, "internal_error");
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const started = Date.now();
    try {
      switch (controller.cron) {
        case CRON.IMPORT_ORDERS:
          await runImportOrders(env, ctx);
          break;
        case CRON.RECONCILE: {
          // Raw webhook payloads hold personal data: purge after 14 days.
          const purged = await purgeWebhookLog(env.DB);
          if (purged) log.info("webhookLog.purged", { rows: purged });
          await runReconcile(env, ctx);
          break;
        }
        default:
          log.warn("cron.unknown", { cron: controller.cron });
          return;
      }
      log.info("cron.done", { cron: controller.cron, ms: Date.now() - started });
    } catch (err) {
      // Rethrow so the invocation is marked failed in Cloudflare's cron history.
      log.error("cron.failed", { cron: controller.cron, ms: Date.now() - started, err });
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
