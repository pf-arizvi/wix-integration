/**
 * Wix API client: base URL + per-site auth headers, on top of lib/http.
 * Each client store has its own API key (created in their Wix account) and site ID.
 */
import type { HttpClient, HttpMethod } from "../../lib/http";

export const WIX_API_BASE = "https://www.wixapis.com";

export interface WixCredentials {
  apiKey: string;
  siteId: string;
}

export interface WixApi {
  request<T>(method: HttpMethod, path: string, body: unknown, opts: { idempotent: boolean }): Promise<T>;
}

export function createWixApi(http: HttpClient, creds: WixCredentials): WixApi {
  if (!creds.apiKey || !creds.siteId) throw new Error("Wix API key and site ID are required");
  const headers = { Authorization: creds.apiKey, "wix-site-id": creds.siteId };
  return {
    async request<T>(method: HttpMethod, path: string, body: unknown, opts: { idempotent: boolean }) {
      const res = await http.request<T>({
        service: "wix",
        method,
        url: WIX_API_BASE + path,
        headers,
        body,
        idempotent: opts.idempotent,
      });
      return res.data;
    },
  };
}
