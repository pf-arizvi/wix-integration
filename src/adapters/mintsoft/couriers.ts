/**
 * Mintsoft courier services and their external-name mappings. Read-only.
 *   listCourierServices        GET /api/Courier/Services
 *   listCourierExternalNames   GET /api/Courier/Services/{id}/ExternalNames
 */
import type { MintsoftApi } from "./client";
import type { MintsoftCourierService, MintsoftExternalCourierName } from "./types";

export async function listCourierServices(api: MintsoftApi): Promise<MintsoftCourierService[]> {
  const res = await api.get<MintsoftCourierService[] | undefined>("/api/Courier/Services");
  return Array.isArray(res) ? res : [];
}

export async function listCourierExternalNames(api: MintsoftApi, serviceId: number): Promise<MintsoftExternalCourierName[]> {
  const res = await api.get<MintsoftExternalCourierName[] | undefined>(
    `/api/Courier/Services/${encodeURIComponent(String(serviceId))}/ExternalNames`,
  );
  return Array.isArray(res) ? res : [];
}
