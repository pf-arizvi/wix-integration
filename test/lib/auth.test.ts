import { describe, expect, it } from "vitest";
import { requireAdmin, safeEqual, verifyWebhookToken } from "../../src/lib/auth";

const TOKEN = "a".repeat(40);
const env = { ADMIN_TOKEN: TOKEN };
const req = (auth?: string) => new Request("https://w.test/admin/x", auth ? { headers: { Authorization: auth } } : {});

describe("safeEqual", () => {
  it("compares strings of any length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });
});

describe("requireAdmin", () => {
  it("allows a valid bearer token", async () => {
    expect(await requireAdmin(req(`Bearer ${TOKEN}`), env)).toBeNull();
    expect(await requireAdmin(req(`bearer ${TOKEN}`), env)).toBeNull();
  });

  it.each([undefined, "", "Bearer", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, "Bearer wrong", `Bearer ${TOKEN} extra`])(
    "rejects %s with 401",
    async (auth) => {
      const res = await requireAdmin(req(auth), env);
      expect(res?.status).toBe(401);
      expect(res?.headers.get("WWW-Authenticate")).toContain("Bearer");
    },
  );

  it("refuses all requests when ADMIN_TOKEN is missing or weak", async () => {
    expect((await requireAdmin(req("Bearer short"), { ADMIN_TOKEN: "short" }))?.status).toBe(503);
    expect((await requireAdmin(req("Bearer "), { ADMIN_TOKEN: "" }))?.status).toBe(503);
  });
});

describe("verifyWebhookToken", () => {
  it("matches only the exact token", async () => {
    expect(await verifyWebhookToken("tok_123", "tok_123")).toBe(true);
    expect(await verifyWebhookToken("tok_124", "tok_123")).toBe(false);
  });
  it("never matches empty values", async () => {
    expect(await verifyWebhookToken(null, "tok")).toBe(false);
    expect(await verifyWebhookToken("", "")).toBe(false);
    expect(await verifyWebhookToken("tok", null)).toBe(false);
  });
});
