/**
 * Admin bearer-token and webhook-token checks. All comparisons are constant-time.
 */
import type { Env } from "../env";
import { log } from "./log";
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
