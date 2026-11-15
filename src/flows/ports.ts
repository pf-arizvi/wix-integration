/**
 * Interfaces flows depend on. Real implementations wrap adapters (flows/deps.ts);
 * tests pass fakes. Another store platform would implement the *SourcePort interfaces.
 */
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
} from "../adapters/mintsoft/types";
import type { CatalogVersion, VariantsPage } from "../adapters/wix/catalog";
import type { CreateFulfilmentResult } from "../adapters/wix/fulfilments";
import type { WixCreateFulfillmentRequest, WixFulfillment, WixOrder } from "../adapters/wix/types";
import type { OrdersPage, SearchPaidUnfulfilledOptions } from "../adapters/wix/orders";
import type { ClientRecord } from "../db/clients";
import type { SubrequestBudget } from "../lib/http";

export interface OrderSourcePort {
  searchPaidUnfulfilled(opts: SearchPaidUnfulfilledOptions): Promise<OrdersPage>;
}

export interface FulfilmentTargetPort {
  getOrder(wixOrderId: string): Promise<WixOrder>;
  listFulfilments(wixOrderId: string): Promise<WixFulfillment[]>;
  createFulfilment(wixOrderId: string, req: WixCreateFulfillmentRequest): Promise<CreateFulfilmentResult>;
}

export interface CatalogSourcePort {
  getCatalogVersion(): Promise<CatalogVersion>;
  queryVariants(opts: { limit: number; cursor?: string | null }): Promise<VariantsPage>;
}

export interface WmsPort {
  /** MINTSOFT_WRITES_ENABLED. */
  readonly writesEnabled: boolean;
  /** MINTSOFT_ALLOWED_CLIENT_IDS. */
  readonly allowedClientIds: ReadonlySet<number>;
  findClientById(id: number): Promise<MintsoftClient | null>;
  findOrdersByNumber(orderNumber: string, clientId: number): Promise<MintsoftOrder[]>;
  lookupProductId(sku: string, clientId: number): Promise<number | null>;
  /** Guarded write (writes enabled + ClientId allowlisted), enforced in the adapter. */
  createOrder(order: MintsoftNewOrder): Promise<MintsoftNewOrderResult>;
  getOrder(id: number): Promise<MintsoftOrder>;
  getOrderItems(id: number): Promise<MintsoftOrderItem[]>;
  /** Guarded write (writes enabled + ClientId allowlisted), enforced in the adapter. */
  createProduct(product: MintsoftNewProduct): Promise<MintsoftNewProductResult>;
  getProduct(id: number): Promise<MintsoftProduct>;
  listCourierServices(): Promise<MintsoftCourierService[]>;
  listCourierExternalNames(serviceId: number): Promise<MintsoftExternalCourierName[]>;
}

export interface FlowDeps {
  db: D1Database;
  budget: SubrequestBudget;
  wms: WmsPort;
  /** Order source for a stored client (decrypts its Wix key). */
  orderSourceFor(client: ClientRecord): Promise<OrderSourcePort>;
  /** Catalog source for a stored client (decrypts its Wix key). */
  catalogSourceFor(client: ClientRecord): Promise<CatalogSourcePort>;
  /** Wix fulfilment target for a stored client (decrypts its Wix key). */
  fulfilmentTargetFor(client: ClientRecord): Promise<FulfilmentTargetPort>;
  /** Order source from raw credentials (onboarding test call). */
  orderSourceFromCredentials(apiKey: string, siteId: string): OrderSourcePort;
  workerBaseUrl: string;
  encryptionKey: string;
  /** MINTSOFT_WAREHOUSE_ID; null = not configured (order import refuses to run). */
  mintsoftWarehouseId: number | null;
}
