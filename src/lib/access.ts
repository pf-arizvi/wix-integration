/**
 * Cloudflare Access login verification for the admin page.
 *
 * Access sits in front of /admin and injects a signed JWT (header Cf-Access-Jwt-Assertion;
 * cookie CF_Authorization). We verify it ourselves — RS256 signature against the team's
 * published keys, audience (the Access application's AUD tag), issuer and expiry — so a
 * request that bypassed Access (or forged the header) is rejected.
 *
 * Config (wrangler.jsonc vars): ACCESS_TEAM_DOMAIN (e.g. "premiumfulfilment.cloudflareaccess.com")
 * and ACCESS_AUD. Either empty → Access login disabled (only the admin token works).
 */
import { base64ToBytes } from "./crypto";
import { createHttpClient } from "./http";

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

export interface AccessIdentity {
  /** Email for people; common name for Access service tokens. */
  actor: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache: { domain: string; at: number; keys: Jwk[] } | undefined;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getKeys(cfg: AccessConfig, fetchImpl?: typeof fetch): Promise<Jwk[]> {
  const now = Date.now();
  if (certsCache && certsCache.domain === cfg.teamDomain && now - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const http = createHttpClient(fetchImpl ? { fetch: fetchImpl } : {});
  const res = await http.request<{ keys?: Jwk[] }>({
    service: "cloudflare-access",
    method: "GET",
    url: `https://${cfg.teamDomain}/cdn-cgi/access/certs`,
    idempotent: true,
  });
  const keys = Array.isArray(res.data?.keys) ? res.data.keys : [];
  certsCache = { domain: cfg.teamDomain, at: now, keys };
  return keys;
}

/** Test hook. */
export function clearAccessKeyCache(): void {
  certsCache = undefined;
}

export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  return teamDomain && aud ? { teamDomain, aud } : null;
}

/** The Access JWT from the request (header first, then cookie), or null. */
export function accessToken(request: Request): string | null {
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h.trim();
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") ?? "");
  return m ? m[1]! : null;
}

/** Verifies an Access JWT. Returns the identity, or null if invalid for any reason. */
export async function verifyAccessJwt(token: string, cfg: AccessConfig, opts: { fetch?: typeof fetch; now?: number } = {}): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  if (!header || !claims || header.alg !== "RS256") return null;

  let keys = await getKeys(cfg, opts.fetch);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Access rotates keys: refresh once.
    clearAccessKeyCache();
    keys = await getKeys(cfg, opts.fetch);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) return null;
  if (claims.iss !== `https://${cfg.teamDomain}`) return null;
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;

  const actor = typeof claims.email === "string" ? claims.email : typeof claims.common_name === "string" ? `service:${claims.common_name}` : null;
  return actor ? { actor } : null;
}
