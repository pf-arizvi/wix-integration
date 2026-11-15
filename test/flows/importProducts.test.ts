import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getClientBySlug } from "../../src/db/clients";
import { ImportConfigError, ImportHaltedError } from "../../src/flows/errors";
import { importProductsPage } from "../../src/flows/importProducts";
import { HttpError, SubrequestBudget } from "../../src/lib/http";
import { fakeCatalog, fakeDeps, fakeOrderSource, fakeWms, insertClient, resetDb, rows, variant } from "../helpers";

const SKUS = ["BLKBAGSMALL", "BLKBAGMEDIUM"];

function setup(variants = SKUS.map((s) => variant(s)), wmsOpts: Parameters<typeof fakeWms>[0] = { skus: [] }) {
  const wms = fakeWms(wmsOpts);
  const catalog = fakeCatalog(variants);
  const deps = fakeDeps(fakeOrderSource([]), wms, new SubrequestBudget(), catalog);
  return { wms, catalog, deps };
}

const page = (deps: ReturnType<typeof setup>["deps"], client: Awaited<ReturnType<typeof insertClient>>, o: Partial<Parameters<typeof importProductsPage>[2]> = {}) =>
  importProductsPage(deps, client, { cursor: null, dryRun: false, ...o });

beforeEach(resetDb);

describe("importProducts — dry run", () => {
  it("returns would-be payloads and writes nothing (Mintsoft or D1)", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    const r = await page(deps, client, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.wouldCreate.map((w) => w.sku)).toEqual(SKUS);
    expect(r.wouldCreate[0]!.payload).toEqual({ ClientId: 38, SKU: "BLKBAGSMALL", Name: "Black Bag - small", Weight: 0.5, Price: 100 });
    expect(wms.createdProducts).toHaveLength(0);
    expect(await rows("SELECT * FROM error_log")).toHaveLength(0);
    expect((await getClientBySlug(env.DB, "wix-test"))!.catalogVersion).toBeNull(); // not even cached
    expect(r).toMatchObject({ done: true, nextCursor: null });
  });

  it("is forced when MINTSOFT_WRITES_ENABLED is off, even if dryRun=false is requested", async () => {
    const client = await insertClient();
    const { wms, deps } = setup(undefined, { skus: [], writesEnabled: false });
    const r = await page(deps, client, { dryRun: false });
    expect(r.dryRun).toBe(true);
    expect(wms.createdProducts).toHaveLength(0);
  });
});

describe("importProducts — real run", () => {
  it("creates missing SKUs, then a re-run skips them all (no duplicates)", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    const r1 = await page(deps, client);
    expect(r1.created.map((c) => c.sku)).toEqual(SKUS);
    expect(wms.createdProducts).toHaveLength(2);
    expect((await getClientBySlug(env.DB, "wix-test"))!.catalogVersion).toBe("V3");

    const r2 = await page(setup(undefined, {}).deps, client); // fresh deps, same Mintsoft state below
    expect(r2.skippedExisting.map((s) => s.sku)).toEqual(SKUS);

    const again = await importProductsPage({ ...deps, budget: new SubrequestBudget() }, client, { cursor: null, dryRun: false });
    expect(again.created).toHaveLength(0);
    expect(again.skippedExisting.map((s) => s.sku)).toEqual(SKUS);
    expect(wms.createdProducts).toHaveLength(2);
  });

  it("never overwrites: SKUs already in Mintsoft are skipped", async () => {
    const client = await insertClient();
    const { wms, deps } = setup(undefined, { skus: ["BLKBAGSMALL"] });
    const r = await page(deps, client);
    expect(r.skippedExisting).toEqual([{ sku: "BLKBAGSMALL", mintsoftProductId: 1 }]);
    expect(wms.createdProducts.map((p) => p.SKU)).toEqual(["BLKBAGMEDIUM"]);
  });

  it("reports missing SKUs, digital products, zero weights and duplicate SKUs", async () => {
    const client = await insertClient();
    const digital = variant("EBOOK");
    digital.productData!.productType = "DIGITAL";
    const { deps } = setup([variant(undefined), digital, variant("NOWEIGHT", { physicalProperties: {} }), variant("DUP"), variant("DUP")]);
    const r = await page(deps, client);
    expect(r.missingSku).toEqual(["Black Bag - ?"]);
    expect(r.skippedNonPhysical).toBe(1);
    expect(r.created).toEqual([
      { sku: "NOWEIGHT", mintsoftProductId: 9000, flags: ["zero_weight"] },
      { sku: "DUP", mintsoftProductId: 9001, flags: [] },
    ]);
    expect(r.duplicateSkuInWix).toEqual(["DUP"]);
  });

  it("honours maxCreates and returns the same cursor so the page is resumed", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    const r = await page(deps, client, { maxCreates: 1 });
    expect(r).toMatchObject({ stoppedBy: "max_creates", nextCursor: null, done: false });
    expect(wms.createdProducts).toHaveLength(1);
  });

  it("pages through the catalogue with nextCursor until done", async () => {
    const client = await insertClient();
    const many = Array.from({ length: 30 }, (_, i) => variant(`SKU${i}`));
    const { wms, deps } = setup(many);
    let cursor: string | null = null;
    let calls = 0;
    do {
      const r = await importProductsPage({ ...deps, budget: new SubrequestBudget() }, client, { cursor, dryRun: false });
      cursor = r.nextCursor;
      calls++;
      if (r.done) break;
    } while (calls < 10);
    expect(calls).toBe(3); // 12 + 12 + 6
    expect(wms.createdProducts).toHaveLength(30);
  });

  it("records Mintsoft rejections and carries on", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    let first = true;
    const realCreate = wms.createProduct.bind(wms);
    wms.createProduct = async (p) => (first ? ((first = false), { Success: false, Message: "Invalid weight" }) : realCreate(p));
    const r = await page(deps, client);
    expect(r.errors).toEqual([{ sku: "BLKBAGSMALL", code: "mintsoft_rejected", message: "SKU BLKBAGSMALL: Mintsoft rejected the product: Invalid weight" }]);
    expect(r.created.map((c) => c.sku)).toEqual(["BLKBAGMEDIUM"]);
    expect(await rows("SELECT code, ref FROM error_log")).toEqual([{ code: "mintsoft_rejected", ref: "BLKBAGSMALL" }]);
  });

  it("stops on an API error and returns the same cursor (safe to re-run)", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    wms.createProduct = async () => {
      throw new HttpError({ kind: "timeout", service: "mintsoft", method: "PUT", url: "x", attempts: 1 });
    };
    const r = await page(deps, client, { cursor: "0" });
    expect(r).toMatchObject({ stoppedBy: "api_error", nextCursor: "0", done: false });
  });
});

describe("importProducts — guardrails", () => {
  it("halts if the SKU lookup doesn't find the product it just created (would cause duplicates)", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    wms.lookupIgnoresCreated = true;
    const err = await page(deps, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportHaltedError);
    expect((err as Error).message).toMatch(/can't be trusted/);
    expect(wms.createdProducts).toHaveLength(1); // stopped after the first
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_verify_failed" }]);
  });

  it("halts and deactivates the client if Mintsoft reports a different ClientId", async () => {
    const client = await insertClient();
    const { wms, deps } = setup();
    wms.reportedProductClientId = 39;
    await expect(page(deps, client)).rejects.toBeInstanceOf(ImportHaltedError);
    expect(wms.createdProducts).toHaveLength(1);
    expect((await getClientBySlug(env.DB, "wix-test"))!.active).toBe(false);
    expect(await rows("SELECT code FROM error_log")).toEqual([{ code: "mintsoft_client_mismatch" }]);
  });

  it("refuses a client whose Mintsoft ID is not allowlisted", async () => {
    const client = await insertClient({ mintsoftClientId: 39 });
    const { wms, deps } = setup();
    await expect(page(deps, client)).rejects.toBeInstanceOf(ImportConfigError);
    expect(wms.createdProducts).toHaveLength(0);
  });

  it("refuses Catalog V1 sites for now", async () => {
    const client = await insertClient();
    const wms = fakeWms({ skus: [] });
    const deps = fakeDeps(fakeOrderSource([]), wms, new SubrequestBudget(), fakeCatalog([variant("A")], "V1"));
    await expect(page(deps, client)).rejects.toThrow(/Catalog V1/);
    expect(wms.createdProducts).toHaveLength(0);
  });

  it("stops before a variant it can't finish within the subrequest budget", async () => {
    const client = await insertClient();
    const { deps } = setup();
    const r = await page({ ...deps, budget: new SubrequestBudget(4) }, client);
    // Fakes don't spend budget; 4 = room for exactly one new product + the lookup proof.
    expect(r.stoppedBy).toBeNull();
    const tight = await page({ ...setup().deps, budget: new SubrequestBudget(3) }, client);
    expect(tight).toMatchObject({ stoppedBy: "subrequest_budget", created: [] });
  });
});
