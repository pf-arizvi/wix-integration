import { env } from "cloudflare:workers";
import type { MintsoftClient, MintsoftNewOrder, MintsoftNewOrderResult, MintsoftOrder } from "../src/adapters/mintsoft/types";
import { checkWriteAllowed } from "../src/adapters/mintsoft/client";
import type { WixOrder } from "../src/adapters/wix/types";
import { createClient, type ClientRecord } from "../src/db/clients";
import { setSyncState } from "../src/db/syncState";
import type { FlowDeps, OrderSourcePort, WmsPort } from "../src/flows/ports";
import { SubrequestBudget } from "../src/lib/http";
import fixture from "./fixtures/wix-order-paid.json";

/** Fresh copy of the real dev-site order (10002), with optional overrides. */
export function wixOrder(overrides: Partial<WixOrder> = {}): WixOrder {
  return { ...(structuredClone(fixture) as WixOrder), ...overrides };
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["webhook_log", "error_log", "sync_state", "order_map", "courier_map", "clients"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
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
  skus: Set<string>;
  /** Override what GET /api/Order/{id} reports as ClientId. */
  reportedClientId?: number;
  createImpl?: (o: MintsoftNewOrder) => Promise<MintsoftNewOrderResult>;
  clients: MintsoftClient[];
}

export function fakeWms(opts: { writesEnabled?: boolean; skus?: string[] } = {}): FakeWms {
  let nextId = 5000;
  const wms: FakeWms = {
    writesEnabled: opts.writesEnabled ?? true,
    allowedClientIds: new Set([38]),
    store: [],
    created: [],
    skus: new Set(opts.skus ?? ["BLKBAGMEDIUM", "BLKBAGSMALL"]),
    clients: [{ ID: 38, Name: "Wix Test Client" }, { ID: 39, Name: "Someone Else" }],
    async findClientById(id) {
      return wms.clients.find((c) => c.ID === id) ?? null;
    },
    async findOrdersByNumber(n, clientId) {
      return wms.store.filter((o) => o.OrderNumber === n && o.ClientId === clientId);
    },
    async lookupProductId(sku) {
      return wms.skus.has(sku) ? 1 : null;
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

export function fakeDeps(source: OrderSourcePort, wms: WmsPort, budget = new SubrequestBudget()): FlowDeps {
  return {
    db: env.DB,
    budget,
    wms,
    orderSourceFor: async () => source,
    orderSourceFromCredentials: () => source,
    workerBaseUrl: "https://worker.test",
    encryptionKey: env.ENCRYPTION_KEY,
  };
}

export async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results;
}
