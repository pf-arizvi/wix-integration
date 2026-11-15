/**
 * Pure: Wix order → Mintsoft PUT /api/Order body (SPEC §4.1). No I/O.
 * Field names: docs/mintsoft-api-swagger.json → NewOrderWithItems / NewOrderItem.
 * Call validateWixOrder() first; this assumes a valid order + its shippable lines.
 */
import type { MintsoftNewOrder } from "../adapters/mintsoft/types";
import type { WixAddress, WixContactDetails, WixLineItem, WixMoney, WixOrder } from "../adapters/wix/types";

export interface OrderMappingContext {
  mintsoftClientId: number;
  mintsoftWarehouseId: number;
  orderNumberPrefix: string;
  courierServiceId: number;
  despatchWebhookUrl: string;
  cancelWebhookUrl: string;
}

/** Postcodes in these countries use the UK format ("HA54DF" → "HA5 4DF"). */
const UK_FORMAT_POSTCODES = new Set(["GB", "GG", "JE", "IM"]);

export function mintsoftOrderNumber(order: Pick<WixOrder, "number">, prefix: string): string {
  return `${prefix ?? ""}${order.number}`;
}

/** Delivery address: recipientInfo, else the shipping destination. NEVER billingInfo (gift orders). */
export function deliveryAddress(order: WixOrder): WixAddress | undefined {
  return order.recipientInfo?.address ?? order.shippingInfo?.logistics?.shippingDestination?.address;
}

/** Recipient contact: recipientInfo → shipping destination → billing (name/phone only). */
export function deliveryContact(order: WixOrder): WixContactDetails | undefined {
  const candidates = [
    order.recipientInfo?.contactDetails,
    order.shippingInfo?.logistics?.shippingDestination?.contactDetails,
    order.billingInfo?.contactDetails,
  ];
  return candidates.find((c) => !!(c?.firstName?.trim() || c?.lastName?.trim() || c?.company?.trim()));
}

export function normalisePostcode(postcode: string | undefined, country: string | undefined): string | undefined {
  const raw = postcode?.trim();
  if (!raw) return undefined;
  if (!country || !UK_FORMAT_POSTCODES.has(country.toUpperCase())) return raw.toUpperCase();
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  return compact.length >= 5 && compact.length <= 7 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : compact;
}

export function money(m: WixMoney | undefined): number | undefined {
  if (m?.amount == null || m.amount === "") return undefined;
  const n = Number(m.amount);
  return Number.isFinite(n) ? n : undefined;
}

export function mapWixOrderToMintsoft(order: WixOrder, lines: readonly WixLineItem[], ctx: OrderMappingContext): MintsoftNewOrder {
  const addr = deliveryAddress(order);
  const contact = deliveryContact(order);
  const country = addr?.country?.toUpperCase();
  const orderNumber = mintsoftOrderNumber(order, ctx.orderNumberPrefix);
  const street = addr?.addressLine?.trim() || [addr?.streetAddress?.number, addr?.streetAddress?.name].filter(Boolean).join(" ");

  const out: MintsoftNewOrder = {
    ClientId: ctx.mintsoftClientId,
    OrderNumber: orderNumber,
    ExternalOrderReference: order.id,
    FirstName: clean(contact?.firstName),
    LastName: clean(contact?.lastName),
    CompanyName: clean(contact?.company),
    Address1: clean(street),
    Address2: clean(addr?.addressLine2),
    Town: clean(addr?.city),
    // For GB, subdivisionFullname is just "England" etc. — omit.
    County: country === "GB" ? undefined : clean(addr?.subdivisionFullname),
    PostCode: normalisePostcode(addr?.postalCode, country),
    Country: country,
    Email: clean(order.buyerInfo?.email),
    Phone: clean(contact?.phone),
    CourierServiceId: ctx.courierServiceId,
    WarehouseId: ctx.mintsoftWarehouseId,
    Currency: clean(order.currency),
    // "Values only" (agreed): no per-line VAT split.
    OrderValue: money(order.priceSummary?.total),
    ShippingTotalExVat: money(order.priceSummary?.shipping),
    TotalVat: money(order.priceSummary?.tax),
    Comments: clean(order.buyerNote),
    OrderItems: lines.map((l) => ({
      SKU: l.physicalProperties!.sku!.trim(),
      Quantity: l.quantity!,
      UnitPrice: money(l.price),
    })),
    ConnectAction: {
      Type: "API", // VERIFY (see MintsoftConnectAction)
      SourceOrderId: order.number,
      Complete: false,
      ExtraCode1: ctx.despatchWebhookUrl,
      ExtraCode2: ctx.cancelWebhookUrl,
    },
  };
  return stripUndefined(out);
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

function stripUndefined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) if (obj[k] === undefined) delete obj[k];
  return obj;
}
