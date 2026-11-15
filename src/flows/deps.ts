/**
 * Wires real adapters into FlowDeps for one invocation (one HTTP client, one
 * subrequest budget shared by Wix + Mintsoft calls).
 */
import { createMintsoftApi } from "../adapters/mintsoft/client";
import { findClientById } from "../adapters/mintsoft/clients";
import { listCourierExternalNames, listCourierServices } from "../adapters/mintsoft/couriers";
import { createOrder, findOrdersByNumber, getOrder, getOrderItems, listDespatchedSince } from "../adapters/mintsoft/orders";
import { createFulfilment, listFulfilments } from "../adapters/wix/fulfilments";
import { createProduct, getProduct, lookupProductId } from "../adapters/mintsoft/products";
import { getCatalogVersion, queryVariantsV3 } from "../adapters/wix/catalog";
import { createWixApi, type WixApi } from "../adapters/wix/client";
import { getOrder as getWixOrder, searchPaidUnfulfilledOrders } from "../adapters/wix/orders";
import { allowedMintsoftClientIds, mintsoftWarehouseId, mintsoftWritesEnabled } from "../config";
import type { ClientRecord } from "../db/clients";
import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { createHttpClient, type HttpClient, SubrequestBudget } from "../lib/http";
import type { CatalogSourcePort, FlowDeps, OrderSourcePort, WmsPort } from "./ports";

export function createFlowDeps(env: Env, opts: { http?: HttpClient } = {}): FlowDeps {
  const budget = opts.http?.budget ?? new SubrequestBudget();
  const http = opts.http ?? createHttpClient({ budget });
  const allowedClientIds = allowedMintsoftClientIds(env);
  const writesEnabled = mintsoftWritesEnabled(env);
  const api = createMintsoftApi(http, { apiKey: env.MINTSOFT_API_KEY, writesEnabled, allowedClientIds });

  const wms: WmsPort = {
    writesEnabled,
    allowedClientIds,
    findClientById: (id) => findClientById(api, id),
    findOrdersByNumber: (n, c) => findOrdersByNumber(api, n, c),
    lookupProductId: (sku, c) => lookupProductId(api, sku, c),
    createOrder: (o) => createOrder(api, o),
    getOrder: (id) => getOrder(api, id),
    getOrderItems: (id) => getOrderItems(api, id),
    listDespatchedSince: (since, page) => listDespatchedSince(api, since, page),
    createProduct: (p) => createProduct(api, p),
    getProduct: (id) => getProduct(api, id),
    listCourierServices: () => listCourierServices(api),
    listCourierExternalNames: (id) => listCourierExternalNames(api, id),
  };

  const wixFor = async (client: ClientRecord): Promise<WixApi> =>
    createWixApi(http, { apiKey: await decryptSecret(client.wixApiKeyEnc, env.ENCRYPTION_KEY), siteId: client.wixSiteId });

  const orderSource = (wix: WixApi): OrderSourcePort => ({ searchPaidUnfulfilled: (o) => searchPaidUnfulfilledOrders(wix, o) });
  const catalogSource = (wix: WixApi): CatalogSourcePort => ({
    getCatalogVersion: () => getCatalogVersion(wix),
    queryVariants: (o) => queryVariantsV3(wix, o),
  });

  return {
    db: env.DB,
    budget,
    wms,
    orderSourceFor: async (client) => orderSource(await wixFor(client)),
    catalogSourceFor: async (client) => catalogSource(await wixFor(client)),
    fulfilmentTargetFor: async (client) => {
      const wix = await wixFor(client);
      return {
        getOrder: (id) => getWixOrder(wix, id),
        listFulfilments: (id) => listFulfilments(wix, id),
        createFulfilment: (id, req) => createFulfilment(wix, id, req),
      };
    },
    orderSourceFromCredentials: (apiKey, siteId) => orderSource(createWixApi(http, { apiKey, siteId })),
    workerBaseUrl: env.WORKER_BASE_URL,
    encryptionKey: env.ENCRYPTION_KEY,
    mintsoftWarehouseId: mintsoftWarehouseId(env),
  };
}
