import { describe, expect, it } from "vitest";
import { base64ToBytes, decryptSecret, encryptSecret, randomToken } from "../../src/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes
const OTHER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 x 0x01

describe("crypto", () => {
  it("round-trips a secret", async () => {
    const enc = await encryptSecret("IST.wix-api-key-value", KEY);
    expect(enc).not.toContain("wix-api-key");
    expect(await decryptSecret(enc, KEY)).toBe("IST.wix-api-key-value");
  });

  it("prefixes a 12-byte IV and uses a fresh IV each time", async () => {
    const a = await encryptSecret("same", KEY);
    const b = await encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    // 12 IV + 4 plaintext + 16 GCM tag
    expect(base64ToBytes(a)).toHaveLength(32);
  });

  it("fails to decrypt with the wrong key, without leaking details", async () => {
    const enc = await encryptSecret("secret", KEY);
    await expect(decryptSecret(enc, OTHER_KEY)).rejects.toThrow(/wrong ENCRYPTION_KEY or corrupted/);
  });

  it("detects tampering", async () => {
    const bytes = base64ToBytes(await encryptSecret("secret", KEY));
    bytes[bytes.length - 1]! ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow(/Failed to decrypt/);
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(encryptSecret("x", btoa("short"))).rejects.toThrow(/32 bytes/);
    await expect(encryptSecret("x", "not base64!!")).rejects.toThrow(/not valid base64/);
  });

  it("rejects malformed ciphertext", async () => {
    await expect(decryptSecret("AAAA", KEY)).rejects.toThrow(/too short/);
  });

  it("generates URL-safe random tokens", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
});
