/**
 * Wix eCom API shapes (subset we use). Only adapters/wix/* and mapping/* may import these.
 * Ref: https://dev.wix.com/docs/rest/business-solutions/e-commerce/orders/order-object
 * Everything optional: parse defensively.
 */

export interface WixMoney {
  amount?: string;
  formattedAmount?: string;
}

export interface WixAddress {
  country?: string; // ISO-2
  subdivision?: string;
  subdivisionFullname?: string;
  city?: string;
  postalCode?: string;
  addressLine?: string;
  addressLine2?: string;
  streetAddress?: { number?: string; name?: string };
  countryFullname?: string;
}

export interface WixContactDetails {
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
}

export interface WixAddressWithContact {
  address?: WixAddress;
  contactDetails?: WixContactDetails;
}

export interface WixLineItem {
  id: string;
  productName?: { original?: string; translated?: string };
  quantity?: number;
  physicalProperties?: { sku?: string; shippable?: boolean; weight?: number };
  itemType?: { preset?: string; custom?: string };
  price?: WixMoney;
}

export interface WixOrder {
  id: string;
  number: string;
  createdDate?: string;
  updatedDate?: string;
  status?: string; // e.g. APPROVED | CANCELED
  paymentStatus?: string; // e.g. PAID
  fulfillmentStatus?: string; // NOT_FULFILLED | PARTIALLY_FULFILLED | FULFILLED
  archived?: boolean;
  currency?: string;
  taxIncludedInPrices?: boolean;
  buyerNote?: string;
  lineItems?: WixLineItem[];
  buyerInfo?: { email?: string; contactId?: string };
  priceSummary?: {
    subtotal?: WixMoney;
    shipping?: WixMoney;
    tax?: WixMoney;
    discount?: WixMoney;
    total?: WixMoney;
  };
  billingInfo?: WixAddressWithContact;
  recipientInfo?: WixAddressWithContact;
  shippingInfo?: {
    title?: string;
    code?: string;
    carrierId?: string;
    logistics?: { shippingDestination?: WixAddressWithContact };
  };
}

/** eCom Order Fulfillments (subset). */
export interface WixFulfillmentLineItem {
  id: string;
  quantity?: number;
}

export interface WixFulfillmentTrackingInfo {
  trackingNumber: string;
  shippingProvider: string;
  trackingLink?: string;
}

export interface WixFulfillment {
  id?: string;
  createdDate?: string;
  lineItems?: WixFulfillmentLineItem[];
  trackingInfo?: WixFulfillmentTrackingInfo;
  customInfo?: { fieldsData?: Record<string, string> };
  /** false = doesn't count towards fulfilled quantities. Unset counts as fulfilled. */
  completed?: boolean;
}

/** Body of POST /ecom/v1/fulfillments/orders/{orderId}/create-fulfillment. lineItems (with ids) are REQUIRED. */
export interface WixCreateFulfillmentRequest {
  fulfillment: {
    lineItems: WixFulfillmentLineItem[];
    trackingInfo?: WixFulfillmentTrackingInfo;
    customInfo?: { fieldsData: Record<string, string> };
  };
}

export interface WixOrderWithFulfillments {
  orderWithFulfillments?: { orderId?: string; fulfillments?: WixFulfillment[] };
  fulfillmentId?: string;
}

/**
 * Catalog V3 Read-Only Variant (subset).
 * https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v3/read-only-variants-v3/query-variants
 */
export interface WixReadOnlyVariant {
  variantId?: string;
  sku?: string;
  barcode?: string;
  visible?: boolean;
  /** weight is only returned when fields includes WEIGHT_MEASUREMENT_UNIT_INFO. */
  physicalProperties?: { weight?: number };
  digitalProperties?: unknown;
  optionChoices?: { optionChoiceNames?: { optionName?: string; choiceName?: string } }[];
  price?: { actualPrice?: WixMoney };
  productData?: {
    productId?: string;
    name?: string;
    productType?: string; // PHYSICAL | DIGITAL
    visible?: boolean;
    physicalProperties?: { weightMeasurementUnitInfo?: { weightMeasurementUnit?: string } }; // KG | LB
  };
}

export interface WixQueryVariantsResponse {
  variants?: WixReadOnlyVariant[];
  pagingMetadata?: WixCursorPagingMetadata;
}

export interface WixCatalogVersionResponse {
  catalogVersion?: string; // V1_CATALOG | V3_CATALOG | STORES_NOT_INSTALLED
}

export interface WixCursorPagingMetadata {
  count?: number;
  hasNext?: boolean;
  cursors?: { next?: string | null; prev?: string | null };
}

export interface WixSearchOrdersResponse {
  orders?: WixOrder[];
  /** Docs name this `metadata`; some pages say `pagingMetadata`. Accept both. */
  metadata?: WixCursorPagingMetadata;
  pagingMetadata?: WixCursorPagingMetadata;
}
