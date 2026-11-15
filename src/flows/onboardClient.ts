/**
 * F5: create a client (SPEC §6.7 POST /admin/clients).
 *
 * Guardrails before anything is saved:
 *   - mintsoft_client_id must be in MINTSOFT_ALLOWED_CLIENT_IDS.
 *   - That ID must exist in Mintsoft (GET /api/Client, read-only) AND its Name must
 *     exactly equal `mintsoftClientName` supplied by the operator. A typo in the ID
 *     therefore cannot silently point a store at another client.
 *   - The Wix key + site ID must work (one search call, read-only).
 * Writes nothing to Mintsoft or Wix.
 *
 * TODO(Phase 4): detect + store catalog_version.
 */
import { createClient, getClientBySlug, type PublicClient, SlugTakenError, toPublicClient } from "../db/clients";
import { setSyncState } from "../db/syncState";
import { encryptSecret, randomToken } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { webhookUrls, type WebhookUrls } from "../lib/webhookUrls";
import type { FlowDeps } from "./ports";

export interface OnboardInput {
  slug: string;
  name: string;
  mintsoftClientId: number;
  /** Must exactly match the client's Name in Mintsoft. */
  mintsoftClientName: string;
  wixSiteId: string;
  wixApiKey: string;
  orderNumberPrefix: string;
  defaultCourierServiceId: number | null;
  defaultCarrierName: string | null;
  /** ISO timestamp. Import orders updated since then (default: now = onboarding time). */
  importOrdersSince: string | null;
}

export type OnboardResult =
  | { ok: true; client: PublicClient; webhooks: WebhookUrls; mintsoftClient: { id: number; name: string } }
  | { ok: false; status: number; error: string; message: string };

const fail = (status: number, error: string, message: string): OnboardResult => ({ ok: false, status, error, message });

export async function onboardClient(deps: FlowDeps, input: OnboardInput): Promise<OnboardResult> {
  if (!deps.wms.allowedClientIds.has(input.mintsoftClientId)) {
    return fail(
      400,
      "mintsoft_client_not_allowed",
      `Mintsoft ClientId ${input.mintsoftClientId} is not in MINTSOFT_ALLOWED_CLIENT_IDS. Add it deliberately before onboarding.`,
    );
  }
  if (await getClientBySlug(deps.db, input.slug)) return fail(409, "slug_taken", `Client slug "${input.slug}" already exists`);
  if (!deps.workerBaseUrl) return fail(503, "config_error", "WORKER_BASE_URL is not set");

  // Mintsoft: ID exists and the name matches exactly.
  let msClient;
  try {
    msClient = await deps.wms.findClientById(input.mintsoftClientId);
  } catch (err) {
    return fail(502, "mintsoft_api_error", `Could not list Mintsoft clients: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!msClient) return fail(400, "mintsoft_client_not_found", `No Mintsoft client with ID ${input.mintsoftClientId}`);
  if (msClient.Name !== input.mintsoftClientName) {
    return fail(
      400,
      "mintsoft_client_name_mismatch",
      `Mintsoft client ${input.mintsoftClientId} is named "${msClient.Name ?? ""}", not "${input.mintsoftClientName}". Nothing was saved.`,
    );
  }

  // Wix: credentials work for this site.
  try {
    await deps
      .orderSourceFromCredentials(input.wixApiKey, input.wixSiteId)
      .searchPaidUnfulfilled({ updatedSince: "2000-01-01T00:00:00.000Z", limit: 1 });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : undefined;
    return fail(400, "wix_credentials_rejected", `Wix test call failed${status ? ` (HTTP ${status})` : ""}. Check the API key, its permissions and the site ID.`);
  }

  const webhookToken = randomToken();
  let client;
  try {
    client = await createClient(deps.db, {
      slug: input.slug,
      name: input.name,
      mintsoftClientId: input.mintsoftClientId,
      wixSiteId: input.wixSiteId,
      wixApiKeyEnc: await encryptSecret(input.wixApiKey, deps.encryptionKey),
      webhookToken,
      orderNumberPrefix: input.orderNumberPrefix,
      defaultCourierServiceId: input.defaultCourierServiceId,
      defaultCarrierName: input.defaultCarrierName,
    });
  } catch (err) {
    if (err instanceof SlugTakenError) return fail(409, "slug_taken", err.message);
    throw err;
  }
  if (input.importOrdersSince) await setSyncState(deps.db, client.id, "orders_cursor", input.importOrdersSince);

  return {
    ok: true,
    client: toPublicClient(client),
    webhooks: webhookUrls(deps.workerBaseUrl, client.slug, webhookToken),
    mintsoftClient: { id: msClient.ID, name: msClient.Name ?? "" },
  };
}
