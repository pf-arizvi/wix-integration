/**
 * carrier_names repository (migration 0003): Mintsoft CourierServiceId → carrier name shown in Wix.
 */

export interface CarrierName {
  mintsoftCourierServiceId: number;
  displayName: string;
}

interface Row {
  mintsoft_courier_service_id: number;
  display_name: string;
}

export async function getCarrierName(db: D1Database, mintsoftCourierServiceId: number): Promise<string | null> {
  const r = await db
    .prepare("SELECT display_name FROM carrier_names WHERE mintsoft_courier_service_id = ?1")
    .bind(mintsoftCourierServiceId)
    .first<{ display_name: string }>();
  return r?.display_name ?? null;
}

export async function listCarrierNames(db: D1Database): Promise<CarrierName[]> {
  const { results } = await db.prepare("SELECT * FROM carrier_names ORDER BY mintsoft_courier_service_id").all<Row>();
  return results.map((r) => ({ mintsoftCourierServiceId: r.mintsoft_courier_service_id, displayName: r.display_name }));
}

export async function upsertCarrierNames(db: D1Database, names: readonly CarrierName[]): Promise<void> {
  if (!names.length) return;
  await db.batch(
    names.map((n) =>
      db
        .prepare(
          `INSERT INTO carrier_names (mintsoft_courier_service_id, display_name) VALUES (?1, ?2)
           ON CONFLICT (mintsoft_courier_service_id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`,
        )
        .bind(n.mintsoftCourierServiceId, n.displayName.trim()),
    ),
  );
}
