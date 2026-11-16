import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getClientBySlug } from "../../src/db/clients";
import { getSyncState } from "../../src/db/syncState";
import { onboardClient, type OnboardInput } from "../../src/flows/onboardClient";
import { decryptSecret } from "../../src/lib/crypto";
import { fakeDeps, fakeOrderSource, fakeWms, resetDb, rows } from "../helpers";

const input = (o: Partial<OnboardInput> = {}): OnboardInput => ({
  slug: "wix-test",
  name: "Wix Test Client",
  mintsoftClientId: 38,
  mintsoftClientName: "Wix Test Client",
  wixSiteId: "site-1",
  wixApiKey: "IST.secret-key",
  orderNumberPrefix: "",
  defaultCourierServiceId: 7,
  defaultCarrierName: "Royal Mail",
  importOrdersSince: null,
  ...o,
});

beforeEach(resetDb);

describe("onboardClient guardrails", () => {
  it("refuses a Mintsoft ClientId that is not allowlisted, without calling anything", async () => {
    const source = fakeOrderSource([]);
    const r = await onboardClient(fakeDeps(source, fakeWms()), input({ mintsoftClientId: 39, mintsoftClientName: "Someone Else" }));
    expect(r).toMatchObject({ ok: false, status: 400, error: "mintsoft_client_not_allowed" });
    expect(source.calls).toBe(0);
    expect(await rows("SELECT * FROM clients")).toHaveLength(0);
  });

  it("refuses when the Mintsoft client name does not match exactly", async () => {
    const r = await onboardClient(fakeDeps(fakeOrderSource([]), fakeWms()), input({ mintsoftClientName: "wix test client" }));
    expect(r).toMatchObject({ ok: false, error: "mintsoft_client_name_mismatch" });
    if (!r.ok) expect(r.message).toContain('named "Wix Test Client"');
    expect(await rows("SELECT * FROM clients")).toHaveLength(0);
  });

  it("refuses when the ID does not exist in Mintsoft", async () => {
    const wms = fakeWms();
    wms.clients = [];
    const r = await onboardClient(fakeDeps(fakeOrderSource([]), wms), input());
    expect(r).toMatchObject({ ok: false, error: "mintsoft_client_not_found" });
  });

  it("refuses when the Wix credentials fail", async () => {
    const source = { searchPaidUnfulfilled: async () => Promise.reject(new Error("401")), getOrder: async () => Promise.reject(new Error("401")) };
    const r = await onboardClient(fakeDeps(source, fakeWms()), input());
    expect(r).toMatchObject({ ok: false, error: "wix_credentials_rejected" });
    expect(await rows("SELECT * FROM clients")).toHaveLength(0);
  });
});

describe("onboardClient success", () => {
  it("stores the client with an encrypted key and returns webhook URLs", async () => {
    const r = await onboardClient(fakeDeps(fakeOrderSource([]), fakeWms()), input({ importOrdersSince: "2026-11-15T11:00:00.000Z" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mintsoftClient).toEqual({ id: 38, name: "Wix Test Client" });
    expect(JSON.stringify(r)).not.toContain("IST.secret-key");
    expect(r.webhooks.despatch).toMatch(/^https:\/\/worker\.test\/webhooks\/mintsoft\/despatch\/wix-test\?token=[A-Za-z0-9_-]{43}$/);

    const stored = (await getClientBySlug(env.DB, "wix-test"))!;
    expect(stored.wixApiKeyEnc).not.toContain("secret");
    expect(await decryptSecret(stored.wixApiKeyEnc, env.ENCRYPTION_KEY)).toBe("IST.secret-key");
    expect(await getSyncState(env.DB, stored.id, "orders_cursor")).toBe("2026-11-15T11:00:00.000Z");
  });

  it("rejects a duplicate slug", async () => {
    await onboardClient(fakeDeps(fakeOrderSource([]), fakeWms()), input());
    const r = await onboardClient(fakeDeps(fakeOrderSource([]), fakeWms()), input());
    expect(r).toMatchObject({ ok: false, status: 409, error: "slug_taken" });
  });
});
