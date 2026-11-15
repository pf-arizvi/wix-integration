/**
 * Wires real adapters into FlowDeps for one invocation (one HTTP client, one
 * subrequest budget shared by Wix + Mintsoft calls).
 */
import { createMintsoftApi } from "../adapters/mintsoft/client";
import { findClientById } from "../adapters/mintsoft/clients";
import { createOrder, findOrdersByNumber, getOrder } from "../adapters/mintsoft/orders";
import { lookupProductId } from "../adapters/mintsoft/products";
import { createWixApi } from "../adapters/wix/client";
import { searchPaidUnfulfilledOrders } from "../adapters/wix/orders";
import { allowedMintsoftClientIds, mintsoftWritesEnabled } from "../config";
import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { createHttpClient, type HttpClient, SubrequestBudget } from "../lib/http";
import type { FlowDeps, OrderSourcePort, WmsPort } from "./ports";

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
  };

  const fromCredentials = (apiKey: string, siteId: string): OrderSourcePort => {
    const wix = createWixApi(http, { apiKey, siteId });
    return { searchPaidUnfulfilled: (o) => searchPaidUnfulfilledOrders(wix, o) };
  };

  return {
    db: env.DB,
    budget,
    wms,
    orderSourceFor: async (client) => fromCredentials(await decryptSecret(client.wixApiKeyEnc, env.ENCRYPTION_KEY), client.wixSiteId),
    orderSourceFromCredentials: fromCredentials,
    workerBaseUrl: env.WORKER_BASE_URL,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
