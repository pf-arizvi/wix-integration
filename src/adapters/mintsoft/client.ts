/**
 * Mintsoft API client (base URL, ms-apikey) with the WRITE GUARDRAILS.
 *
 * Every write to Mintsoft must go through `write()`, which refuses — before any
 * network call — unless:
 *   1. MINTSOFT_WRITES_ENABLED is exactly "true", and
 *   2. the target ClientId is in MINTSOFT_ALLOWED_CLIENT_IDS.
 * Reads (`get`) are always allowed: they cannot change Mintsoft data.
 *
 * Never add a write path that bypasses `write()`.
 */
import type { HttpClient } from "../../lib/http";

export const MINTSOFT_API_BASE = "https://api.mintsoft.co.uk";

export type MintsoftGuardCode = "mintsoft_writes_disabled" | "mintsoft_client_not_allowed";

export class MintsoftWriteBlockedError extends Error {
  override readonly name = "MintsoftWriteBlockedError";
  constructor(
    readonly code: MintsoftGuardCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MintsoftConfig {
  apiKey: string;
  writesEnabled: boolean;
  allowedClientIds: ReadonlySet<number>;
}

export interface MintsoftApi {
  readonly writesEnabled: boolean;
  /** Throws MintsoftWriteBlockedError if a write for `clientId` would be refused. */
  assertWriteAllowed(clientId: unknown): void;
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  write<T>(method: "PUT" | "POST", path: string, body: unknown, clientId: unknown): Promise<T>;
}

export function checkWriteAllowed(cfg: Pick<MintsoftConfig, "writesEnabled" | "allowedClientIds">, clientId: unknown): void {
  if (!cfg.writesEnabled) {
    throw new MintsoftWriteBlockedError("mintsoft_writes_disabled", "Mintsoft writes are disabled (MINTSOFT_WRITES_ENABLED is not \"true\")");
  }
  if (typeof clientId !== "number" || !Number.isInteger(clientId) || !cfg.allowedClientIds.has(clientId)) {
    throw new MintsoftWriteBlockedError(
      "mintsoft_client_not_allowed",
      `Mintsoft ClientId ${String(clientId)} is not in MINTSOFT_ALLOWED_CLIENT_IDS`,
    );
  }
}

export function createMintsoftApi(http: HttpClient, cfg: MintsoftConfig): MintsoftApi {
  if (!cfg.apiKey) throw new Error("MINTSOFT_API_KEY is not set");
  const headers = { "ms-apikey": cfg.apiKey };

  return {
    writesEnabled: cfg.writesEnabled,
    assertWriteAllowed: (clientId) => checkWriteAllowed(cfg, clientId),

    async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
      const res = await http.request<T>({
        service: "mintsoft",
        method: "GET",
        url: buildUrl(path, query),
        headers,
        idempotent: true,
      });
      return res.data;
    },

    async write<T>(method: "PUT" | "POST", path: string, body: unknown, clientId: unknown) {
      checkWriteAllowed(cfg, clientId);
      const res = await http.request<T>({
        service: "mintsoft",
        method,
        url: buildUrl(path),
        headers,
        body,
        // Creates are not safe to repeat: only 429 is retried (see lib/http.ts).
        idempotent: false,
      });
      return res.data;
    },
  };
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(MINTSOFT_API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}
