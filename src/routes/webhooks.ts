/**
 * Mintsoft → us webhooks (registered on each order via ConnectAction).
 *   POST /webhooks/mintsoft/despatch/:slug?token=…   (ExtraCode1)
 *   POST /webhooks/mintsoft/cancel/:slug?token=…     (ExtraCode2)
 *
 * - The per-client token is checked in constant time. Unknown slug and bad token look identical (401).
 * - Once authenticated, always 200 (avoid Mintsoft retry storms). Failures are recorded
 *   in error_log / order_map and retried by reconcile (Phase 3).
 * - Raw payload stored only when DEBUG_PAYLOADS=true (it contains personal data).
 */
import { debugPayloads } from "../config";
import type { ClientRecord } from "../db/clients";
import { getClientBySlug } from "../db/clients";
import { recordError } from "../db/errors";
import { logWebhookPayload } from "../db/webhookLog";
import { createFlowDeps } from "../flows/deps";
import { handleCancel, handleDespatch } from "../flows/pushTracking";
import type { Env } from "../env";
import { verifyWebhookToken } from "../lib/auth";
import { log } from "../lib/log";
import { errorJson, json } from "../lib/response";
import type { Handler, RouteContext } from "../router";

const MAX_BODY_CHARS = 256 * 1024;
/** Compared against when the slug is unknown, so timing doesn't reveal which slugs exist. */
const DUMMY_TOKEN = "x".repeat(43);

async function authenticate(c: RouteContext): Promise<ClientRecord | null> {
  const client = await getClientBySlug(c.env.DB, c.params.slug!);
  const ok = await verifyWebhookToken(c.url.searchParams.get("token"), client?.webhookToken ?? DUMMY_TOKEN);
  return ok && client ? client : null;
}

async function readPayload(request: Request): Promise<{ raw: string; payload: unknown }> {
  const raw = (await request.text()).slice(0, MAX_BODY_CHARS);
  try {
    return { raw, payload: raw ? JSON.parse(raw) : null };
  } catch {
    return { raw, payload: null };
  }
}

function webhook(source: "mintsoft_despatch" | "mintsoft_cancel", run: typeof handleDespatch | typeof handleCancel): Handler {
  return async (c) => {
    const client = await authenticate(c);
    if (!client) return errorJson(401, "unauthorized");

    const { raw, payload } = await readPayload(c.request);
    const env: Env = c.env;
    try {
      if (debugPayloads(env)) await logWebhookPayload(env.DB, client.id, source, raw);
      if (!client.active) {
        await recordError(env.DB, {
          clientId: client.id,
          flow: "pushTracking",
          ref: null,
          code: "config_error",
          message: `${source} webhook received for inactive client ${client.slug}; not processed`,
        });
        return json({ ok: true, processed: false, reason: "client_inactive" });
      }
      if (payload == null) {
        await recordError(env.DB, { clientId: client.id, flow: "pushTracking", ref: null, code: "despatch_payload_invalid", message: `${source} webhook body was not JSON` });
        return json({ ok: true, processed: false, reason: "invalid_json" });
      }
      const result = await run(createFlowDeps(env), client, payload);
      return json({ ok: true, processed: true, result });
    } catch (err) {
      log.error("webhook.failed", { source, client: client.slug, err });
      try {
        await recordError(env.DB, {
          clientId: client.id,
          flow: "pushTracking",
          ref: null,
          code: "internal_error",
          message: `${source} webhook failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        /* logged above */
      }
      // Still 200: authenticated and logged; reconcile retries.
      return json({ ok: true, processed: false, reason: "internal_error" });
    }
  };
}

export const despatchWebhookHandler = webhook("mintsoft_despatch", handleDespatch);
export const cancelWebhookHandler = webhook("mintsoft_cancel", handleCancel);
