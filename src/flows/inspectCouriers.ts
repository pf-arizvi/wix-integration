/**
 * Read-only diagnostic: Mintsoft courier services and the external names mapped to
 * each (Mintsoft's own courier mapping). Writes nothing anywhere.
 * Paged by service (one ExternalNames call per service) to stay within the subrequest budget.
 */
import type { FlowDeps } from "./ports";

export interface CourierServiceSummary {
  id: number;
  name: string | null;
  active: boolean | null;
  externalNames: { name: string | null; source: string | null; clientId: number | null }[];
}

export interface CourierInspection {
  totalServices: number;
  activeServices: number;
  offset: number;
  services: CourierServiceSummary[];
  /** Pass as ?offset= to see the next services; null when done. */
  nextOffset: number | null;
}

export async function inspectCourierMappings(
  deps: FlowDeps,
  opts: { offset: number; limit: number; includeInactive: boolean },
): Promise<CourierInspection> {
  const all = (await deps.wms.listCourierServices()).slice().sort((a, b) => a.ID - b.ID);
  const candidates = opts.includeInactive ? all : all.filter((s) => s.ActiveB !== false);
  const limit = Math.max(0, Math.min(opts.limit, deps.budget.remaining));
  const slice = candidates.slice(opts.offset, opts.offset + limit);

  const services: CourierServiceSummary[] = [];
  for (const s of slice) {
    const names = await deps.wms.listCourierExternalNames(s.ID);
    services.push({
      id: s.ID,
      name: s.Name ?? null,
      active: s.ActiveB ?? null,
      externalNames: names.map((n) => ({ name: n.Name ?? null, source: n.Source ?? null, clientId: n.ClientId ?? null })),
    });
  }
  const end = opts.offset + slice.length;
  return {
    totalServices: all.length,
    activeServices: all.filter((s) => s.ActiveB !== false).length,
    offset: opts.offset,
    services,
    nextOffset: end < candidates.length ? end : null,
  };
}
