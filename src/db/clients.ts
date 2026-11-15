/**
 * clients repository (SPEC §5). The only place that reads/writes the clients table.
 * `PublicClient` never includes wix_api_key_enc or webhook_token.
 */

export interface ClientRecord {
  id: number;
  slug: string;
  name: string;
  mintsoftClientId: number;
  wixSiteId: string;
  wixApiKeyEnc: string;
  webhookToken: string;
  orderNumberPrefix: string;
  defaultCourierServiceId: number | null;
  defaultCarrierName: string | null;
  catalogVersion: string | null;
  active: boolean;
  /** ISO 8601 UTC. */
  createdAt: string;
}

export type PublicClient = Omit<ClientRecord, "wixApiKeyEnc" | "webhookToken">;

export interface NewClient {
  slug: string;
  name: string;
  mintsoftClientId: number;
  wixSiteId: string;
  wixApiKeyEnc: string;
  webhookToken: string;
  orderNumberPrefix: string;
  defaultCourierServiceId: number | null;
  defaultCarrierName: string | null;
}

export class SlugTakenError extends Error {
  override readonly name = "SlugTakenError";
}

interface ClientRow {
  id: number;
  slug: string;
  name: string;
  mintsoft_client_id: number;
  wix_site_id: string;
  wix_api_key_enc: string;
  webhook_token: string;
  order_number_prefix: string | null;
  default_courier_service_id: number | null;
  default_carrier_name: string | null;
  catalog_version: string | null;
  active: number;
  created_at: string;
}

/** SQLite datetime('now') → ISO 8601 UTC. */
export function sqliteToIso(s: string): string {
  return s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
}

function toRecord(r: ClientRow): ClientRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    mintsoftClientId: r.mintsoft_client_id,
    wixSiteId: r.wix_site_id,
    wixApiKeyEnc: r.wix_api_key_enc,
    webhookToken: r.webhook_token,
    orderNumberPrefix: r.order_number_prefix ?? "",
    defaultCourierServiceId: r.default_courier_service_id,
    defaultCarrierName: r.default_carrier_name,
    catalogVersion: r.catalog_version,
    active: r.active === 1,
    createdAt: sqliteToIso(r.created_at),
  };
}

export function toPublicClient(c: ClientRecord): PublicClient {
  const { wixApiKeyEnc: _k, webhookToken: _t, ...pub } = c;
  return pub;
}

export async function countClients(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM clients").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createClient(db: D1Database, c: NewClient): Promise<ClientRecord> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO clients (slug, name, mintsoft_client_id, wix_site_id, wix_api_key_enc, webhook_token,
                              order_number_prefix, default_courier_service_id, default_carrier_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING *`,
      )
      .bind(
        c.slug,
        c.name,
        c.mintsoftClientId,
        c.wixSiteId,
        c.wixApiKeyEnc,
        c.webhookToken,
        c.orderNumberPrefix,
        c.defaultCourierServiceId,
        c.defaultCarrierName,
      )
      .first<ClientRow>();
    if (!row) throw new Error("INSERT INTO clients returned no row");
    return toRecord(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: clients\.slug/.test(err.message)) {
      throw new SlugTakenError(`Client slug "${c.slug}" already exists`);
    }
    throw err;
  }
}

export async function getClientBySlug(db: D1Database, slug: string): Promise<ClientRecord | null> {
  const row = await db.prepare("SELECT * FROM clients WHERE slug = ?1").bind(slug).first<ClientRow>();
  return row ? toRecord(row) : null;
}

export async function listClients(db: D1Database): Promise<ClientRecord[]> {
  const { results } = await db.prepare("SELECT * FROM clients ORDER BY id").all<ClientRow>();
  return results.map(toRecord);
}

export async function listActiveClients(db: D1Database): Promise<ClientRecord[]> {
  const { results } = await db.prepare("SELECT * FROM clients WHERE active = 1 ORDER BY id").all<ClientRow>();
  return results.map(toRecord);
}

export async function setCatalogVersion(db: D1Database, id: number, version: string): Promise<void> {
  await db.prepare("UPDATE clients SET catalog_version = ?2 WHERE id = ?1").bind(id, version).run();
}

/** Guardrail circuit-breaker: stop all automated work for a client. Re-enable manually. */
export async function deactivateClient(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE clients SET active = 0 WHERE id = ?1").bind(id).run();
}
