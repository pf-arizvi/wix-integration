import { env } from "cloudflare:workers";
import type {
  MintsoftClient,
  MintsoftCourierService,
  MintsoftExternalCourierName,
  MintsoftNewOrder,
  MintsoftNewOrderResult,
  MintsoftNewProduct,
  MintsoftNewProductResult,
  MintsoftOrder,
  MintsoftOrderItem,
  MintsoftProduct,
} from "../src/adapters/mintsoft/types";
import { checkWriteAllowed } from "../src/adapters/mintsoft/client";
import type { CatalogVersion } from "../src/adapters/wix/catalog";
import type { WixCreateFulfillmentRequest, WixFulfillment, WixOrder, WixReadOnlyVariant } from "../src/adapters/wix/types";
import { createClient, type ClientRecord } from "../src/db/clients";
import { setSyncState } from "../src/db/syncState";
import type { CatalogSourcePort, FlowDeps, FulfilmentTargetPort, OrderSourcePort, WmsPort } from "../src/flows/ports";
import { SubrequestBudget } from "../src/lib/http";
import fixture from "./fixtures/wix-order-paid.json";

/** Fresh copy of the real dev-site order (10002), with optional overrides. */
export function wixOrder(overrides: Partial<WixOrder> = {}): WixOrder {
  return { ...(structuredClone(fixture) as WixOrder), ...overrides };
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["webhook_log", "error_log", "carrier_names", "fulfilments", "sync_state", "order_map", "courier_map", "clients"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export async function insertClient(overrides: Partial<Parameters<typeof createClient>[1]> = {}, cursor = "2026-11-15T00:00:00.000Z"): Promise<ClientRecord> {
  const c = await createClient(env.DB, {
    slug: "wix-test",
    name: "Wix Test Client",
    mintsoftClientId: 38,
    wixSiteId: "site-1",
    wixApiKeyEnc: "unused-by-fakes",
    webhookToken: "tok_test",
    orderNumberPrefix: "",
    defaultCourierServiceId: 7,
    defaultCarrierName: "Royal Mail",
    ...overrides,
  });
  await setSyncState(env.DB, c.id, "orders_cursor", cursor);
  return c;
}

/** In-memory Wix: honours updatedSince, ASC order, limit + numeric cursor. */
export function fakeOrderSource(orders: WixOrder[]): OrderSourcePort & { calls: number } {
  const src = {
    calls: 0,
    async searchPaidUnfulfilled(opts: { updatedSince: string; limit: number; cursor?: string | null }) {
      src.calls++;
      const matching = orders
        .filter((o) => Date.parse(o.updatedDate!) >= Date.parse(opts.updatedSince))
        .sort((a, b) => Date.parse(a.updatedDate!) - Date.parse(b.updatedDate!));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = matching.slice(start, start + opts.limit);
      const next = start + opts.limit < matching.length ? String(start + opts.limit) : null;
      return { orders: page, nextCursor: next };
    },
  };
  return src;
}

export interface FakeWms extends WmsPort {
  store: MintsoftOrder[];
  created: MintsoftNewOrder[];
  /** SKUs that "exist" in Mintsoft (lookup returns 1 for these). */
  skus: Set<string>;
  /** Products created through createProduct. */
  products: MintsoftProduct[];
  createdProducts: MintsoftNewProduct[];
  /** Override what GET /api/Order/{id} reports as ClientId. */
  reportedClientId?: number;
  /** Override what GET /api/Product/{id} reports as ClientId. */
  reportedProductClientId?: number;
  createImpl?: (o: MintsoftNewOrder) => Promise<MintsoftNewOrderResult>;
  createProductImpl?: (p: MintsoftNewProduct) => Promise<MintsoftNewProductResult>;
  /** Simulate a lookup that never "sees" created products. */
  lookupIgnoresCreated?: boolean;
  clients: MintsoftClient[];
  courierServices: MintsoftCourierService[];
  /** Mintsoft order id → its items (GET /api/Order/{id}/Items). */
  orderItems: Record<number, MintsoftOrderItem[]>;
  /** Orders returned by Order/List?SinceDespatchDate (all clients), oldest first. */
  despatched: MintsoftOrder[];
  listCalls: { since: string; page: number }[];
  /** serviceId → external names mapped to it. */
  courierNames: Record<number, MintsoftExternalCourierName[]>;
}

export function fakeWms(opts: { writesEnabled?: boolean; skus?: string[] } = {}): FakeWms {
  let nextId = 5000;
  let nextProductId = 9000;
  const wms: FakeWms = {
    writesEnabled: opts.writesEnabled ?? true,
    allowedClientIds: new Set([38]),
    store: [],
    created: [],
    skus: new Set(opts.skus ?? ["BLKBAGMEDIUM", "BLKBAGSMALL"]),
    products: [],
    createdProducts: [],
    clients: [{ ID: 38, Name: "Wix Test Client" }, { ID: 39, Name: "Someone Else" }],
    courierServices: [
      { ID: 16, Name: "Royal Mail 48", ActiveB: true },
      { ID: 14, Name: "Royal Mail Tracked 24", ActiveB: true },
      { ID: 3, Name: "Old Courier", ActiveB: false },
    ],
    orderItems: {},
    despatched: [],
    listCalls: [],
    async listDespatchedSince(since, page) {
      wms.listCalls.push({ since, page });
      const from = Date.parse(`${since}Z`);
      const all = wms.despatched
        .filter((o) => Date.parse(`${o.DespatchDate}Z`) >= from)
        .sort((a, b) => Date.parse(`${a.DespatchDate}Z`) - Date.parse(`${b.DespatchDate}Z`));
      return all.slice((page - 1) * 100, page * 100);
    },
    async getOrderItems(id) {
      return wms.orderItems[id] ?? [];
    },
    courierNames: { 14: [{ ID: 1, CourierServiceId: 14, Name: "Express Shipping", Source: "Wix", ClientId: 38 }] },
    async listCourierServices() {
      return wms.courierServices;
    },
    async listCourierExternalNames(id) {
      return wms.courierNames[id] ?? [];
    },
    async findClientById(id) {
      return wms.clients.find((c) => c.ID === id) ?? null;
    },
    async findOrdersByNumber(n, clientId) {
      return wms.store.filter((o) => o.OrderNumber === n && o.ClientId === clientId);
    },
    async lookupProductId(sku, clientId) {
      const p = wms.lookupIgnoresCreated ? undefined : wms.products.find((x) => x.SKU === sku && x.ClientId === clientId);
      if (p) return p.ID;
      return wms.skus.has(sku) ? 1 : null;
    },
    async createProduct(p) {
      checkWriteAllowed(wms, p.ClientId); // same guard as the real adapter
      if (wms.createProductImpl) return wms.createProductImpl(p);
      wms.createdProducts.push(p);
      const id = nextProductId++;
      wms.products.push({ ID: id, SKU: p.SKU, ClientId: p.ClientId, Name: p.Name });
      return { Success: true, ProductId: id, SKU: p.SKU };
    },
    async getProduct(id) {
      const p = wms.products.find((x) => x.ID === id);
      if (!p) throw new Error(`product ${id} not found`);
      return { ...p, ClientId: wms.reportedProductClientId ?? p.ClientId };
    },
    async createOrder(o) {
      checkWriteAllowed(wms, o.ClientId); // same guard as the real adapter
      if (wms.createImpl) return wms.createImpl(o);
      wms.created.push(o);
      const id = nextId++;
      wms.store.push({ ID: id, ClientId: o.ClientId, OrderNumber: o.OrderNumber, WarehouseId: 1, ChannelId: 2 });
      return { Success: true, OrderId: id, OrderNumber: o.OrderNumber };
    },
    async getOrder(id) {
      const o = wms.store.find((x) => x.ID === id);
      if (!o) throw new Error(`order ${id} not found`);
      return { ...o, ClientId: wms.reportedClientId ?? o.ClientId };
    },
  };
  return wms;
}

/** In-memory Wix catalog V3: pages of `limit` with numeric cursors. */
export function fakeCatalog(variants: WixReadOnlyVariant[], version: CatalogVersion = "V3"): CatalogSourcePort & { versionCalls: number; pages: number } {
  const cat = {
    versionCalls: 0,
    pages: 0,
    async getCatalogVersion() {
      cat.versionCalls++;
      return version;
    },
    async queryVariants(opts: { limit: number; cursor?: string | null }) {
      cat.pages++;
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const end = start + opts.limit;
      return { variants: variants.slice(start, end), nextCursor: end < variants.length ? String(end) : null };
    },
  };
  return cat;
}

/** A V3 variant like the dev site's "Black Bag". */
export function variant(sku: string | undefined, overrides: Partial<WixReadOnlyVariant> = {}): WixReadOnlyVariant {
  return {
    variantId: `v-${sku ?? "nosku"}`,
    sku,
    visible: true,
    physicalProperties: { weight: 0.5 },
    optionChoices: [{ optionChoiceNames: { optionName: "Size", choiceName: sku?.replace("BLKBAG", "").toLowerCase() ?? "?" } }],
    price: { actualPrice: { amount: "100.00" } },
    productData: {
      productId: "p-blackbag",
      name: "Black Bag",
      productType: "PHYSICAL",
      physicalProperties: { weightMeasurementUnitInfo: { weightMeasurementUnit: "KG" } },
    },
    ...overrides,
  };
}

/** In-memory Wix fulfilments: enforces remaining quantities and duplicate tracking numbers like Wix does. */
export interface FakeWix extends FulfilmentTargetPort {
  orders: Map<string, WixOrder>;
  fulfilments: Map<string, WixFulfillment[]>;
  requests: { orderId: string; req: WixCreateFulfillmentRequest }[];
  failNextCreate?: Error;
}

export function fakeWix(orders: WixOrder[] = [wixOrder()]): FakeWix {
  let n = 0;
  const wix: FakeWix = {
    orders: new Map(orders.map((o) => [o.id, o])),
    fulfilments: new Map(),
    requests: [],
    async getOrder(id) {
      const o = wix.orders.get(id);
      if (!o) throw new Error(`wix order ${id} not found`);
      return structuredClone(o);
    },
    async listFulfilments(id) {
      return structuredClone(wix.fulfilments.get(id) ?? []);
    },
    async createFulfilment(id, req) {
      if (wix.failNextCreate) {
        const e = wix.failNextCreate;
        wix.failNextCreate = undefined;
        throw e;
      }
      wix.requests.push({ orderId: id, req });
      const list = wix.fulfilments.get(id) ?? [];
      const t = req.fulfillment.trackingInfo;
      if (t && list.some((f) => f.trackingInfo?.trackingNumber === t.trackingNumber && f.trackingInfo?.shippingProvider === t.shippingProvider)) {
        return { status: "already_exists" as const };
      }
      const fid = `f-${++n}`;
      list.push({ id: fid, lineItems: req.fulfillment.lineItems, ...(t ? { trackingInfo: t } : {}) });
      wix.fulfilments.set(id, list);
      return { status: "created" as const, fulfillmentId: fid };
    },
  };
  return wix;
}

export function fakeDeps(
  source: OrderSourcePort,
  wms: WmsPort,
  budget = new SubrequestBudget(),
  catalog: CatalogSourcePort = fakeCatalog([]),
  wix: FulfilmentTargetPort = fakeWix(),
): FlowDeps {
  return {
    db: env.DB,
    budget,
    wms,
    fulfilmentTargetFor: async () => wix,
    catalogSourceFor: async () => catalog,
    orderSourceFor: async () => source,
    orderSourceFromCredentials: () => source,
    workerBaseUrl: "https://worker.test",
    encryptionKey: env.ENCRYPTION_KEY,
    mintsoftWarehouseId: 3,
  };
}

export async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results;
}
