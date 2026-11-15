/**
 * clients repository (SPEC §5). The only place that reads/writes the clients table.
 * Never return wix_api_key_enc from list queries.
 *
 * TODO(Phase 1): createClient, getClientBySlug, listActiveClients, listClients (no keys).
 */

export async function countClients(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM clients").first<{ n: number }>();
  return row?.n ?? 0;
}
