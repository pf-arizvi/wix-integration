/**
 * courier_map repository. Titles are matched case-insensitively (see mapping/courierMap.ts);
 * upserts replace any existing row whose title differs only by case/whitespace.
 */
import type { CourierRule } from "../mapping/courierMap";

interface Row {
  wix_shipping_title: string;
  mintsoft_courier_service_id: number;
  carrier_display_name: string | null;
}

export async function listCourierRules(db: D1Database, clientId: number): Promise<CourierRule[]> {
  const { results } = await db
    .prepare(
      "SELECT wix_shipping_title, mintsoft_courier_service_id, carrier_display_name FROM courier_map WHERE client_id = ?1 ORDER BY wix_shipping_title",
    )
    .bind(clientId)
    .all<Row>();
  return results.map((r) => ({
    wixShippingTitle: r.wix_shipping_title,
    mintsoftCourierServiceId: r.mintsoft_courier_service_id,
    carrierDisplayName: r.carrier_display_name,
  }));
}

export async function upsertCourierRules(db: D1Database, clientId: number, rules: readonly CourierRule[]): Promise<void> {
  if (!rules.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (const r of rules) {
    const title = r.wixShippingTitle.trim().replace(/\s+/g, " ");
    stmts.push(
      db
        .prepare("DELETE FROM courier_map WHERE client_id = ?1 AND lower(trim(wix_shipping_title)) = lower(?2)")
        .bind(clientId, title),
      db
        .prepare(
          "INSERT INTO courier_map (client_id, wix_shipping_title, mintsoft_courier_service_id, carrier_display_name) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(clientId, title, r.mintsoftCourierServiceId, r.carrierDisplayName),
    );
  }
  await db.batch(stmts);
}
