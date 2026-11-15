/**
 * Mintsoft products.
 *   lookupProductId  GET /api/Product/LookupProductId?SKU=&ClientId=  → integer product ID
 *
 * TODO(Phase 4): createProduct (PUT /api/Product). Never sends stock.
 */
import { HttpError } from "../../lib/http";
import type { MintsoftApi } from "./client";

/**
 * Returns the Mintsoft product ID for `sku` under `clientId`, or null if not found.
 * VERIFY: what LookupProductId returns for an unknown SKU — handled here as 0,
 * empty, a non-number, or HTTP 404. Other errors propagate.
 */
export async function lookupProductId(api: MintsoftApi, sku: string, clientId: number): Promise<number | null> {
  try {
    const res = await api.get<unknown>("/api/Product/LookupProductId", { SKU: sku, ClientId: clientId });
    const id = typeof res === "number" ? res : typeof res === "string" ? Number(res) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    if (err instanceof HttpError && err.kind === "http" && err.status === 404) return null;
    throw err;
  }
}
