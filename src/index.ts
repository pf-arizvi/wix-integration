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
  auditHandler,
  courierServicesHandler,
  createClientHandler,
  getCourierMapHandler,
  listOrdersHandler,
  setWritesHandler,
  stateHandler,
  listCarriersHandler,
  putCarriersHandler,
  importProductsHandler,
  listClientsHandler,
  listErrorsHandler,
  putCourierMapHandler,
  reconcileHandler,
  resolveErrorHandler,
  retryOrderHandler,
  runImportHandler,
} from "./routes/admin";
import { cancelWebhookHandler, despatchWebhookHandler } from "./routes/webhooks";
import { adminCssHandler, adminJsHandler, adminPageHandler } from "./routes/ui";
import { purgeWebhookLog } from "./db/webhookLog";
import { setSetting } from "./db/settings";

const router = new Router()
  // Unauthenticated liveness probe. Touches nothing, returns no data.
  .get("/healthz", () => json({ ok: true }))
  // Admin page (static; data via the authenticated API below).
  .get("/admin", adminPageHandler)
  .get("/admin/app.css", adminCssHandler)
  .get("/admin/app.js", adminJsHandler)
  // Phase 0: proves admin auth + D1 binding + migrations. Expanded in Phase 3 (SPEC §6.7).
  .get(
    "/admin/health",
    adminOnly(async ({ env }) => json({ ok: true, db: { clients: await countClients(env.DB) } })),
  )
  .get("/admin/state", adminOnly(stateHandler))
  .put("/admin/settings/writes", adminOnly(setWritesHandler))
  .get("/admin/audit", adminOnly(auditHandler))
  .get("/admin/clients/:slug/orders", adminOnly(listOrdersHandler))
  .get("/admin/clients/:slug/courier-map", adminOnly(getCourierMapHandler))
  .post("/admin/clients", adminOnly(createClientHandler))
  .get("/admin/clients", adminOnly(listClientsHandler))
  .get("/admin/mintsoft/courier-services", adminOnly(courierServicesHandler))
  .put("/admin/clients/:slug/courier-map", adminOnly(putCourierMapHandler))
  .post("/admin/clients/:slug/import-products", adminOnly(importProductsHandler))
  .post("/admin/clients/:slug/run-import", adminOnly(runImportHandler))
  .post("/admin/clients/:slug/orders/:wixOrderNumber/retry", adminOnly(retryOrderHandler))
  .get("/admin/errors", adminOnly(listErrorsHandler))
  .post("/admin/errors/:id/resolve", adminOnly(resolveErrorHandler))
  .post("/admin/reconcile", adminOnly(reconcileHandler))
  .get("/admin/carriers", adminOnly(listCarriersHandler))
  .put("/admin/carriers", adminOnly(putCarriersHandler))
  // Mintsoft webhooks: authenticated by the per-client token in the URL, not the admin token.
  .post("/webhooks/mintsoft/despatch/:slug", despatchWebhookHandler)
  .post("/webhooks/mintsoft/cancel/:slug", cancelWebhookHandler);
// TODO(Phase 3): fuller /admin/health (last run times per flow, counts by status).
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
    const flow = controller.cron === CRON.IMPORT_ORDERS ? "importOrders" : controller.cron === CRON.RECONCILE ? "reconcile" : null;
    if (!flow) {
      log.warn("cron.unknown", { cron: controller.cron });
      return;
    }
    try {
      let summary: Record<string, unknown>;
      if (flow === "importOrders") {
        summary = await runImportOrders(env, ctx);
      } else {
        // Raw webhook payloads hold personal data: purge after 14 days.
        const purged = await purgeWebhookLog(env.DB);
        if (purged) log.info("webhookLog.purged", { rows: purged });
        summary = await runReconcile(env, ctx);
      }
      log.info("cron.done", { cron: controller.cron, ms: Date.now() - started });
      await setSetting(env.DB, `last_run:${flow}`, JSON.stringify({ ok: true, ms: Date.now() - started, ...summary }), null);
    } catch (err) {
      // Rethrow so the invocation is marked failed in Cloudflare's cron history.
      log.error("cron.failed", { cron: controller.cron, ms: Date.now() - started, err });
      await setSetting(env.DB, `last_run:${flow}`, JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), null).catch(() => {});
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
