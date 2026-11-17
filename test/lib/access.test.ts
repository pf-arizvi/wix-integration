import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache, verifyAccessJwt } from "../../src/lib/access";
import { authenticateAdmin } from "../../src/lib/auth";

const CFG = { teamDomain: "pf.cloudflareaccess.com", aud: "aud-123" };
const ENV = { ADMIN_TOKEN: "t".repeat(40), ACCESS_TEAM_DOMAIN: CFG.teamDomain, ACCESS_AUD: CFG.aud };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
let certCalls = 0;
const certsFetch = (async () => {
  certCalls++;
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
}) as unknown as typeof fetch;

async function sign(claims: Record<string, unknown>, kid = "k1", key = keys.privateKey): Promise<string> {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ aud: [CFG.aud], iss: `https://${CFG.teamDomain}`, exp: now() + 600, nbf: now() - 10, email: "arizvi@premiumfulfilment.co.uk" });

beforeEach(async () => {
  clearAccessKeyCache();
  certCalls = 0;
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});

describe("verifyAccessJwt", () => {
  it("accepts a valid Access login and returns the email", async () => {
    expect(await verifyAccessJwt(await sign(good()), CFG, { fetch: certsFetch })).toEqual({ actor: "arizvi@premiumfulfilment.co.uk" });
  });

  it.each([
    ["wrong audience", { aud: ["other"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: now() - 5 }],
    ["not yet valid", { nbf: now() + 3600 }],
  ])("rejects %s", async (_l, override) => {
    expect(await verifyAccessJwt(await sign({ ...good(), ...override }), CFG, { fetch: certsFetch })).toBeNull();
  });

  it("rejects a token signed by another key, a tampered payload, and junk", async () => {
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await verifyAccessJwt(await sign(good(), "k1", other.privateKey), CFG, { fetch: certsFetch })).toBeNull();
    const t = (await sign(good())).split(".");
    const tampered = [t[0], enc({ ...good(), email: "attacker@example.com" }), t[2]].join(".");
    expect(await verifyAccessJwt(tampered, CFG, { fetch: certsFetch })).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", CFG, { fetch: certsFetch })).toBeNull();
    expect(await verifyAccessJwt("abc", CFG, { fetch: certsFetch })).toBeNull();
  });

  it("caches the signing keys", async () => {
    await verifyAccessJwt(await sign(good()), CFG, { fetch: certsFetch });
    await verifyAccessJwt(await sign(good()), CFG, { fetch: certsFetch });
    expect(certCalls).toBe(1);
  });
});

describe("authenticateAdmin", () => {
  const req = (method: string, headers: Record<string, string>) => new Request("https://w.test/admin/state", { method, headers });

  it("accepts the admin token (CLI) without the UI header", async () => {
    expect(await authenticateAdmin(req("POST", { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` }), ENV)).toEqual({ actor: "admin-token", via: "admin-token" });
  });

  it("records the Hub user from X-Actor when the admin token is valid, and ignores junk", async () => {
    const auth = { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` };
    expect(await authenticateAdmin(req("POST", { ...auth, "X-Actor": "ARizvi@PremiumFulfilment.co.uk" }), ENV)).toEqual({
      actor: "hub:arizvi@premiumfulfilment.co.uk",
      via: "admin-token",
    });
    expect(await authenticateAdmin(req("POST", { ...auth, "X-Actor": "a b\u0007<script>" }), ENV)).toEqual({ actor: "admin-token", via: "admin-token" });
    // X-Actor never authenticates on its own.
    expect(((await authenticateAdmin(req("POST", { "X-Actor": "arizvi@premiumfulfilment.co.uk" }), ENV)) as Response).status).toBe(401);
  });

  it("accepts an Access login on GET; requires X-Admin-UI on state-changing requests", async () => {
    const jwt = await sign(good());
    expect(await authenticateAdmin(req("GET", { "Cf-Access-Jwt-Assertion": jwt }), ENV, { fetch: certsFetch })).toEqual({
      actor: "arizvi@premiumfulfilment.co.uk",
      via: "access",
    });
    const noHeader = await authenticateAdmin(req("POST", { "Cf-Access-Jwt-Assertion": jwt }), ENV, { fetch: certsFetch });
    expect((noHeader as Response).status).toBe(403);
    expect(await authenticateAdmin(req("POST", { "Cf-Access-Jwt-Assertion": jwt, "X-Admin-UI": "1" }), ENV, { fetch: certsFetch })).toMatchObject({ via: "access" });
  });

  it("reads the Access cookie too", async () => {
    const jwt = await sign(good());
    expect(await authenticateAdmin(req("GET", { Cookie: `x=1; CF_Authorization=${jwt}` }), ENV, { fetch: certsFetch })).toMatchObject({ via: "access" });
  });

  it("rejects a forged Access header and anything when Access isn't configured", async () => {
    const forged = await sign({ ...good(), aud: ["nope"] });
    expect(((await authenticateAdmin(req("GET", { "Cf-Access-Jwt-Assertion": forged }), ENV, { fetch: certsFetch })) as Response).status).toBe(401);
    const off = { ...ENV, ACCESS_AUD: "" };
    expect(((await authenticateAdmin(req("GET", { "Cf-Access-Jwt-Assertion": await sign(good()) }), off, { fetch: certsFetch })) as Response).status).toBe(401);
  });
});
