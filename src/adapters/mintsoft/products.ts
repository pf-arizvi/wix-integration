/**
 * Mintsoft products.
 *   lookupProductId  GET /api/Product/LookupProductId?SKU=&ClientId=  → integer product ID
 *   createProduct    PUT /api/Product (guarded write) → NewProductResult
 *   getProduct       GET /api/Product/{id}
 * Never sends stock.
 */
import { HttpError } from "../../lib/http";
import type { MintsoftApi } from "./client";
import type { MintsoftNewProduct, MintsoftNewProductResult, MintsoftProduct } from "./types";

/**
 * Returns the Mintsoft product ID for `sku` under `clientId`, or null if not found.
 * VERIFY: what LookupProductId returns for an unknown SKU — handled here as 0,
 * empty, a non-number, or HTTP 404. Other errors propagate.
 * The product import proves the "found" path on its first create (see flows/importProducts.ts).
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

export async function createProduct(api: MintsoftApi, product: MintsoftNewProduct): Promise<MintsoftNewProductResult> {
  // Guarded write: ClientId from the body itself is what gets checked.
  const res = await api.write<MintsoftNewProductResult | MintsoftNewProductResult[] | undefined>(
    "PUT",
    "/api/Product",
    product,
    product.ClientId,
  );
  const first = Array.isArray(res) ? res[0] : res;
  return first ?? { Success: false, Message: "Empty response from PUT /api/Product" };
}

export async function getProduct(api: MintsoftApi, id: number): Promise<MintsoftProduct> {
  return api.get<MintsoftProduct>(`/api/Product/${encodeURIComponent(String(id))}`);
}
