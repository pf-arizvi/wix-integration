/**
 * Mintsoft clients. GET /api/Client (pageNo, limit ≤ 100). Read-only.
 */
import { MINTSOFT_CLIENT_SCAN_MAX_PAGES } from "../../config";
import type { MintsoftApi } from "./client";
import type { MintsoftClient } from "./types";

const PAGE_SIZE = 100;

/** Finds a Mintsoft client by ID, paging through GET /api/Client. Null if not found. */
export async function findClientById(api: MintsoftApi, id: number): Promise<MintsoftClient | null> {
  for (let pageNo = 1; pageNo <= MINTSOFT_CLIENT_SCAN_MAX_PAGES; pageNo++) {
    const page = await api.get<MintsoftClient[] | undefined>("/api/Client", { pageNo, limit: PAGE_SIZE });
    const rows = Array.isArray(page) ? page : [];
    const hit = rows.find((c) => c.ID === id);
    if (hit) return hit;
    if (rows.length < PAGE_SIZE) return null;
  }
  return null;
}
