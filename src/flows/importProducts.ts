/**
 * F4: Wix variants → Mintsoft products for one client (SPEC §6.6). Manual, at onboarding.
 *
 * One page of Wix variants per call; returns `nextCursor` for the caller to continue
 * (scripts/import-products.sh loops). Safe to re-run any page: existing SKUs are
 * skipped, never overwritten. Never touches stock.
 *
 * Per variant: skip digital / report missing SKU → SKU already in Mintsoft for this
 * client? skip → [dry run stops here] → create (guarded write)
 * → read back and confirm ClientId.
 *
 * Guardrails beyond the adapter's switch + allowlist:
 *   - Read-back ClientId mismatch → client deactivated, run halted.
 *   - The first product created in each call is looked up again by SKU; if the lookup
 *     doesn't return that product, the run halts. A lookup we can't trust would make
 *     every re-run create duplicates.
 *
 * Dry run (MINTSOFT_WRITES_ENABLED != "true", or ?dryRun): writes nothing
 * anywhere and returns the would-be payloads.
 */
import type { MintsoftNewProduct } from "../adapters/mintsoft/types";
import { MintsoftWriteBlockedError } from "../adapters/mintsoft/client";
import type { CatalogVersion } from "../adapters/wix/catalog";
import { PRODUCT_IMPORT_PAGE_SIZE } from "../config";
import { type ClientRecord, deactivateClient, setCatalogVersion } from "../db/clients";
import { recordError } from "../db/errors";
import type { ErrorCode } from "../errorCodes";
import { HttpError } from "../lib/http";
import { log } from "../lib/log";
import { mapWixVariantToMintsoft, type ProductFlag } from "../mapping/productMapper";
import { ImportConfigError, ImportHaltedError } from "./errors";
import type { FlowDeps } from "./ports";

export interface ProductImportOptions {
  /** Wix cursor from the previous call's `nextCursor`; null = start. */
  cursor: string | null;
  dryRun: boolean;
  /** Max products to CREATE in this call (e.g. 1 for a first cautious run). */
  maxCreates?: number;
}

export interface ProductImportReport {
  client: string;
  catalogVersion: CatalogVersion;
  dryRun: boolean;
  variantsSeen: number;
  created: { sku: string; mintsoftProductId: number; flags: ProductFlag[] }[];
  wouldCreate: { sku: string; flags: ProductFlag[]; payload: MintsoftNewProduct }[];
  skippedExisting: { sku: string; mintsoftProductId: number }[];
  missingSku: string[];
  duplicateSkuInWix: string[];
  skippedNonPhysical: number;
  errors: { sku: string; code: ErrorCode; message: string }[];
  /** Pass back as ?cursor= to continue. Null when done. */
  nextCursor: string | null;
  done: boolean;
  stoppedBy: "max_creates" | "subrequest_budget" | "api_error" | null;
}

/** Worst case per variant: lookup + create + read-back. */
const CALLS_PER_NEW_PRODUCT = 3;

export async function importProductsPage(deps: FlowDeps, client: ClientRecord, opts: ProductImportOptions): Promise<ProductImportReport> {
  const dryRun = opts.dryRun || !deps.wms.writesEnabled;
  const msClientId = client.mintsoftClientId;

  if (!deps.wms.allowedClientIds.has(msClientId)) {
    throw new ImportConfigError(
      "mintsoft_client_not_allowed",
      `Client ${client.slug}: Mintsoft ClientId ${msClientId} is not in MINTSOFT_ALLOWED_CLIENT_IDS`,
    );
  }

  const source = await deps.catalogSourceFor(client);
  let version = (client.catalogVersion as CatalogVersion | null) ?? null;
  if (!version) {
    version = await source.getCatalogVersion();
    if (!dryRun && (version === "V1" || version === "V3")) await setCatalogVersion(deps.db, client.id, version);
  }
  if (version !== "V3") {
    throw new ImportConfigError(
      "config_error",
      version === "V1"
        ? `Client ${client.slug} uses Wix Catalog V1, which product import does not support yet`
        : `Client ${client.slug}: Wix catalog version is ${version}`,
    );
  }

  const report: ProductImportReport = {
    client: client.slug,
    catalogVersion: version,
    dryRun,
    variantsSeen: 0,
    created: [],
    wouldCreate: [],
    skippedExisting: [],
    missingSku: [],
    duplicateSkuInWix: [],
    skippedNonPhysical: 0,
    errors: [],
    nextCursor: null,
    done: false,
    stoppedBy: null,
  };

  const page = await source.queryVariants({ limit: PRODUCT_IMPORT_PAGE_SIZE, cursor: opts.cursor });
  report.variantsSeen = page.variants.length;

  const seen = new Set<string>();
  let lookupProven = false;

  const fail = async (sku: string, code: ErrorCode, message: string) => {
    report.errors.push({ sku, code, message });
    if (!dryRun) await recordError(deps.db, { clientId: client.id, flow: "importProducts", ref: sku, code, message });
  };

  for (const variant of page.variants) {
    const mapped = mapWixVariantToMintsoft(variant, { mintsoftClientId: msClientId });
    if (mapped.kind === "non_physical") {
      report.skippedNonPhysical++;
      continue;
    }
    if (mapped.kind === "missing_sku") {
      report.missingSku.push(mapped.label);
      continue;
    }
    const { product, flags } = mapped;
    const sku = product.SKU;
    if (seen.has(sku)) {
      report.duplicateSkuInWix.push(sku);
      continue;
    }
    seen.add(sku);

    if (!deps.budget.has(CALLS_PER_NEW_PRODUCT + (lookupProven ? 0 : 1))) {
      report.stoppedBy = "subrequest_budget";
      break;
    }

    try {
      const existingId = await deps.wms.lookupProductId(sku, msClientId);
      if (existingId != null) {
        report.skippedExisting.push({ sku, mintsoftProductId: existingId });
        continue;
      }
      if (dryRun) {
        report.wouldCreate.push({ sku, flags, payload: product });
        continue;
      }
      if (opts.maxCreates !== undefined && report.created.length >= opts.maxCreates) {
        report.stoppedBy = "max_creates";
        break;
      }

      const res = await deps.wms.createProduct(product);
      if (!res.Success || !res.ProductId) {
        await fail(sku, "mintsoft_rejected", `SKU ${sku}: Mintsoft rejected the product: ${res.Message?.trim() || "no message"}`);
        continue;
      }
      const productId = res.ProductId;

      // Read back: must belong to the right client.
      const createdProduct = await deps.wms.getProduct(productId);
      if (createdProduct.ClientId !== msClientId) {
        const message =
          `SKU ${sku} was created as Mintsoft product ${productId} but Mintsoft reports ClientId ${String(createdProduct.ClientId)} ` +
          `(expected ${msClientId}). Client ${client.slug} deactivated; product import halted. Check Mintsoft immediately.`;
        await recordError(deps.db, { clientId: client.id, flow: "importProducts", ref: sku, code: "mintsoft_client_mismatch", message });
        await deactivateClient(deps.db, client.id);
        log.error("importProducts.client_mismatch", { client: client.slug, sku, productId, reportedClientId: createdProduct.ClientId });
        throw new ImportHaltedError(message);
      }

      // Prove the duplicate check works before relying on it for the rest of the catalogue.
      if (!lookupProven) {
        const found = await deps.wms.lookupProductId(sku, msClientId);
        if (found !== productId) {
          const message =
            `SKU ${sku} was created as Mintsoft product ${productId}, but LookupProductId returned ${String(found)}. ` +
            `The existing-SKU check can't be trusted, so product import has stopped to avoid creating duplicates.`;
          await recordError(deps.db, { clientId: client.id, flow: "importProducts", ref: sku, code: "mintsoft_verify_failed", message });
          report.created.push({ sku, mintsoftProductId: productId, flags });
          log.error("importProducts.lookup_unreliable", { client: client.slug, sku, productId, found });
          throw new ImportHaltedError(message);
        }
        lookupProven = true;
      }

      report.created.push({ sku, mintsoftProductId: productId, flags });
      log.info("importProducts.created", { client: client.slug, sku, productId, flags });
    } catch (err) {
      if (err instanceof ImportHaltedError) throw err;
      if (err instanceof MintsoftWriteBlockedError) {
        await fail(sku, err.code, err.message);
        report.stoppedBy = "api_error";
        break;
      }
      if (err instanceof HttpError) {
        // A create may have succeeded server-side; re-running this page is safe (lookup skips it).
        await fail(sku, err.kind === "budget_exhausted" ? "mintsoft_api_error" : "mintsoft_api_error", `SKU ${sku}: ${err.message}`);
        report.stoppedBy = err.kind === "budget_exhausted" ? "subrequest_budget" : "api_error";
        break;
      }
      throw err;
    }
  }

  // Stopped part-way → repeat this same page next call (already-created SKUs are skipped).
  report.nextCursor = report.stoppedBy ? opts.cursor : page.nextCursor;
  report.done = !report.stoppedBy && !page.nextCursor;
  return report;
}
