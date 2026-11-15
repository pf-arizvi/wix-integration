/**
 * Interfaces flows depend on. Real implementations wrap adapters (flows/deps.ts);
 * tests pass fakes. Another store platform would implement OrderSourcePort.
 */
import type { MintsoftClient, MintsoftNewOrder, MintsoftNewOrderResult, MintsoftOrder } from "../adapters/mintsoft/types";
import type { OrdersPage, SearchPaidUnfulfilledOptions } from "../adapters/wix/orders";
import type { ClientRecord } from "../db/clients";
import type { SubrequestBudget } from "../lib/http";

export interface OrderSourcePort {
  searchPaidUnfulfilled(opts: SearchPaidUnfulfilledOptions): Promise<OrdersPage>;
}

export interface WmsPort {
  /** Global MINTSOFT_WRITES_ENABLED switch. */
  readonly writesEnabled: boolean;
  /** MINTSOFT_ALLOWED_CLIENT_IDS. */
  readonly allowedClientIds: ReadonlySet<number>;
  findClientById(id: number): Promise<MintsoftClient | null>;
  findOrdersByNumber(orderNumber: string, clientId: number): Promise<MintsoftOrder[]>;
  lookupProductId(sku: string, clientId: number): Promise<number | null>;
  /** Guarded write (writes enabled + ClientId allowlisted), enforced in the adapter. */
  createOrder(order: MintsoftNewOrder): Promise<MintsoftNewOrderResult>;
  getOrder(id: number): Promise<MintsoftOrder>;
}

export interface FlowDeps {
  db: D1Database;
  budget: SubrequestBudget;
  wms: WmsPort;
  /** Order source for a stored client (decrypts its Wix key). */
  orderSourceFor(client: ClientRecord): Promise<OrderSourcePort>;
  /** Order source from raw credentials (onboarding test call). */
  orderSourceFromCredentials(apiKey: string, siteId: string): OrderSourcePort;
  workerBaseUrl: string;
  encryptionKey: string;
}
