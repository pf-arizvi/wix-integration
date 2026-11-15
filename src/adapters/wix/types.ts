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
