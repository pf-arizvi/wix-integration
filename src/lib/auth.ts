/**
 * Admin bearer-token and webhook-token checks. All comparisons are constant-time.
 */
import type { Env } from "../env";
import { log } from "./log";
import { accessConfig, accessToken, verifyAccessJwt } from "./access";
import { errorJson } from "./response";

/** Refuse to run admin endpoints with a weak/missing ADMIN_TOKEN. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/**
 * Constant-time string compare. Both sides are SHA-256 hashed first so the
 * comparison is fixed-length and leaks neither content nor length.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * Returns null when the request carries a valid `Authorization: Bearer <ADMIN_TOKEN>`,
 * otherwise the error Response to send.
 */
export async function requireAdmin(request: Request, env: Pick<Env, "ADMIN_TOKEN">): Promise<Response | null> {
  const expected = env.ADMIN_TOKEN ?? "";
  if (expected.length < MIN_ADMIN_TOKEN_LENGTH) {
    log.error("auth.admin_token_misconfigured", { minLength: MIN_ADMIN_TOKEN_LENGTH });
    return errorJson(503, "admin_disabled", "ADMIN_TOKEN is not configured");
  }
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match || !(await safeEqual(match[1]!, expected))) {
    return errorJson(401, "unauthorized", undefined, { "WWW-Authenticate": 'Bearer realm="admin"' });
  }
  return null;
}

/** Compares the `token` query param on a webhook URL against the client's stored token. */
export async function verifyWebhookToken(provided: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!provided || !expected) return false;
  return safeEqual(provided, expected);
}

export interface AdminIdentity {
  /** Access email, "service:<name>" for Access service tokens, or "admin-token". */
  actor: string;
  via: "access" | "admin-token";
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Admin auth for the API and the admin page. Accepts either:
 *   - `Authorization: Bearer <ADMIN_TOKEN>` (curl / scripts), or
 *   - a Cloudflare Access login, verified here (signature, audience, issuer, expiry).
 * Access-authenticated requests that change state must also send `X-Admin-UI: 1`: a custom
 * header a cross-site form can't add, so a logged-in browser can't be driven from another site.
 */
export async function authenticateAdmin(
  request: Request,
  env: Pick<Env, "ADMIN_TOKEN"> & { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string },
  opts: { fetch?: typeof fetch } = {},
): Promise<AdminIdentity | Response> {
  if (request.headers.has("Authorization")) {
    return (await requireAdmin(request, env)) ?? { actor: "admin-token", via: "admin-token" };
  }
  const cfg = accessConfig(env);
  const token = accessToken(request);
  if (cfg && token) {
    let id;
    try {
      id = await verifyAccessJwt(token, cfg, opts);
    } catch (err) {
      log.error("auth.access_verify_failed", { err });
      return errorJson(503, "access_unavailable", "Could not verify the Cloudflare Access login");
    }
    if (id) {
      if (!SAFE_METHODS.has(request.method) && request.headers.get("X-Admin-UI") !== "1") {
        return errorJson(403, "forbidden", "Missing X-Admin-UI header");
      }
      return { actor: id.actor, via: "access" };
    }
  }
  return errorJson(401, "unauthorized", undefined, { "WWW-Authenticate": 'Bearer realm="admin"' });
}
