import { describe, expect, it } from "vitest";
import { mapWixVariantToMintsoft, variantLabel, weightKg } from "../../src/mapping/productMapper";
import { variant } from "../helpers";

const ctx = { mintsoftClientId: 38 };

describe("mapWixVariantToMintsoft", () => {
  it("maps a dev-site style variant per SPEC §4.3", () => {
    expect(mapWixVariantToMintsoft(variant("BLKBAGMEDIUM", { barcode: " 5012345678900 " }), ctx)).toEqual({
      kind: "ok",
      flags: [],
      product: { ClientId: 38, SKU: "BLKBAGMEDIUM", Name: "Black Bag - medium", Weight: 0.5, EAN: "5012345678900", Price: 100 },
    });
  });

  it("never includes stock", () => {
    const m = mapWixVariantToMintsoft(variant("A"), ctx);
    if (m.kind !== "ok") throw new Error("expected ok");
    expect(Object.keys(m.product).sort()).toEqual(["ClientId", "Name", "Price", "SKU", "Weight"]);
  });

  it("creates with Weight 0 and flags it when Wix has no weight (agreed rule)", () => {
    const noWeight = mapWixVariantToMintsoft(variant("A", { physicalProperties: {} }), ctx);
    expect(noWeight).toMatchObject({ kind: "ok", flags: ["zero_weight"], product: { Weight: 0 } });
    const zero = mapWixVariantToMintsoft(variant("A", { physicalProperties: { weight: 0 } }), ctx);
    expect(zero).toMatchObject({ kind: "ok", flags: ["zero_weight"] });
  });

  it("imports hidden variants like visible ones (agreed rule)", () => {
    const v = variant("A", { visible: false });
    v.productData!.visible = false;
    expect(mapWixVariantToMintsoft(v, ctx).kind).toBe("ok");
  });

  it("reports a missing SKU with a readable label", () => {
    expect(mapWixVariantToMintsoft(variant(undefined), ctx)).toEqual({ kind: "missing_sku", label: "Black Bag - ?" });
    expect(mapWixVariantToMintsoft(variant("   "), ctx).kind).toBe("missing_sku");
  });

  it("skips digital products", () => {
    const v = variant("EBOOK");
    v.productData!.productType = "DIGITAL";
    expect(mapWixVariantToMintsoft(v, ctx)).toEqual({ kind: "non_physical" });
  });
});

describe("variantLabel", () => {
  it("joins product name and option choices", () => {
    const v = variant("A", {
      optionChoices: [{ optionChoiceNames: { choiceName: "Medium" } }, { optionChoiceNames: { choiceName: "Red" } }],
    });
    expect(variantLabel(v)).toBe("Black Bag - Medium / Red");
    expect(variantLabel(variant("A", { optionChoices: [] }))).toBe("Black Bag");
  });
});

describe("weightKg", () => {
  it("converts LB to kg and rounds to grams", () => {
    const v = variant("A", { physicalProperties: { weight: 2 } });
    v.productData!.physicalProperties = { weightMeasurementUnitInfo: { weightMeasurementUnit: "LB" } };
    expect(weightKg(v)).toBe(0.907);
  });
  it("returns null for missing or invalid weights", () => {
    expect(weightKg(variant("A", { physicalProperties: {} }))).toBeNull();
    expect(weightKg(variant("A", { physicalProperties: { weight: -1 } }))).toBeNull();
  });
});
