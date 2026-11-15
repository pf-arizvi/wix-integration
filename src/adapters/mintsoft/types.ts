/**
 * Mintsoft API shapes — subset of docs/mintsoft-api-swagger.json (Swagger 2.0, "API V1").
 * Field names below are taken from the Swagger definitions named in each comment.
 * Behaviour (what Mintsoft does with them) is still VERIFY where marked.
 */

/** Swagger: NewOrderConnectAction. Registers webhooks on an order. */
export interface MintsoftConnectAction {
  // VERIFY: "API" is the documented Type for ASN webhooks
  // (PUT /api/ASN/{id}/ConnectActions: "Type = API, ExtraCode1 = Callback Url,
  // ExtraCode4 = Auth Header Values, Complete = false"). Assumed the same for orders.
  Type: string;
  SourceOrderId?: string;
  Complete: boolean;
  /** Despatch callback URL. */
  ExtraCode1?: string;
  /** Cancel callback URL. VERIFY: ExtraCode2 = cancel URL for orders. */
  ExtraCode2?: string;
}

/** Swagger: NewOrderItem. */
export interface MintsoftNewOrderItem {
  SKU: string;
  Quantity: number;
  UnitPrice?: number;
}

/** Swagger: NewOrderWithItems (body of PUT /api/Order). */
export interface MintsoftNewOrder {
  ClientId: number;
  OrderNumber: string;
  ExternalOrderReference?: string;
  FirstName?: string;
  LastName?: string;
  CompanyName?: string;
  Address1?: string;
  Address2?: string;
  Town?: string;
  County?: string;
  PostCode?: string;
  // VERIFY: Mintsoft accepts ISO-2 ("GB") in Country (string). CountryId (int) is the alternative.
  Country?: string;
  Email?: string;
  Phone?: string;
  CourierServiceId?: number;
  Currency?: string;
  OrderValue?: number;
  ShippingTotalExVat?: number;
  TotalVat?: number;
  Comments?: string;
  OrderItems: MintsoftNewOrderItem[];
  ConnectAction?: MintsoftConnectAction;
}

/** Swagger: NewOrderResult. PUT /api/Order returns an array of these. */
export interface MintsoftNewOrderResult {
  OrderId?: number;
  OrderNumber?: string;
  Success?: boolean;
  OrderStatusId?: number;
  OrderStatus?: string;
  Message?: string;
}

/** Swagger: Order (subset). GET /api/Order/{id}, GET /api/Order/Search. */
export interface MintsoftOrder {
  ID: number;
  ClientId?: number;
  OrderNumber?: string;
  ExternalOrderReference?: string;
  OrderStatusId?: number;
  WarehouseId?: number;
  ChannelId?: number;
  CourierServiceId?: number;
  CourierServiceName?: string;
  TrackingNumber?: string;
  TrackingURL?: string;
}

/** Swagger: Client (subset). GET /api/Client. */
export interface MintsoftClient {
  ID: number;
  Name?: string;
  ShortName?: string;
  Active?: string;
}
