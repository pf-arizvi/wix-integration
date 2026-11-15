/**
 * Pure: Wix Catalog V3 variant → Mintsoft PUT /api/Product body (SPEC §4.3). No I/O.
 * Never maps stock.
 *
 * Agreed rules:
 *   - Missing SKU → not created, reported.
 *   - Digital products → skipped.
 *   - Hidden products/variants → imported like visible ones.
 *   - Missing weight → created with Weight 0 and flagged "zero_weight".
 */
import type { MintsoftNewProduct } from "../adapters/mintsoft/types";
import type { WixReadOnlyVariant } from "../adapters/wix/types";
import { money } from "./orderMapper";

const LB_TO_KG = 0.45359237;

export type ProductFlag = "zero_weight";

export type VariantMapping =
  | { kind: "ok"; product: MintsoftNewProduct; flags: ProductFlag[] }
  | { kind: "non_physical" }
  | { kind: "missing_sku"; label: string };

export function variantLabel(v: WixReadOnlyVariant): string {
  const base = v.productData?.name?.trim() || "Unnamed product";
  const choices = (v.optionChoices ?? [])
    .map((c) => c.optionChoiceNames?.choiceName?.trim())
    .filter((s): s is string => !!s);
  return choices.length ? `${base} - ${choices.join(" / ")}` : base;
}

/** Weight in kg, or null if Wix has none. VERIFY: Mintsoft Weight is kg. */
export function weightKg(v: WixReadOnlyVariant): number | null {
  const w = v.physicalProperties?.weight;
  if (typeof w !== "number" || !Number.isFinite(w) || w < 0) return null;
  const unit = v.productData?.physicalProperties?.weightMeasurementUnitInfo?.weightMeasurementUnit;
  const kg = unit === "LB" ? w * LB_TO_KG : w;
  return Math.round(kg * 1000) / 1000;
}

export function mapWixVariantToMintsoft(v: WixReadOnlyVariant, ctx: { mintsoftClientId: number }): VariantMapping {
  if (v.productData?.productType === "DIGITAL" || v.digitalProperties) return { kind: "non_physical" };

  const label = variantLabel(v);
  const sku = v.sku?.trim();
  if (!sku) return { kind: "missing_sku", label };

  const kg = weightKg(v);
  const flags: ProductFlag[] = kg ? [] : ["zero_weight"];
  const product: MintsoftNewProduct = {
    ClientId: ctx.mintsoftClientId,
    SKU: sku,
    Name: label,
    Weight: kg ?? 0,
  };
  const barcode = v.barcode?.trim();
  if (barcode) product.EAN = barcode;
  const price = money(v.price?.actualPrice);
  if (price !== undefined) product.Price = price;
  return { kind: "ok", product, flags };
}
