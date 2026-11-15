/**
 * AES-GCM (256-bit) encryption for per-client secrets stored in D1
 * (clients.wix_api_key_enc), keyed by the ENCRYPTION_KEY secret.
 *
 * Stored format: base64( iv[12 bytes] || ciphertext+tag ).
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

let cached: { raw: string; key: Promise<CryptoKey> } | undefined;

function getKey(keyB64: string): Promise<CryptoKey> {
  if (cached?.raw === keyB64) return cached.key;
  const key = (async () => {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(keyB64.trim());
    } catch {
      throw new Error("ENCRYPTION_KEY is not valid base64");
    }
    if (bytes.length !== KEY_BYTES) {
      throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${bytes.length})`);
    }
    return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  // Don't cache failures.
  key.catch(() => {
    if (cached?.key === key) cached = undefined;
  });
  cached = { raw: keyB64, key };
  return key;
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await getKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return bytesToBase64(out);
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const key = await getKey(keyB64);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload);
  } catch {
    throw new Error("Encrypted value is not valid base64");
  }
  if (bytes.length <= IV_BYTES) throw new Error("Encrypted value is too short");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
      key,
      bytes.subarray(IV_BYTES),
    );
    return new TextDecoder().decode(pt);
  } catch {
    // Never include key material or ciphertext in the message.
    throw new Error("Failed to decrypt value (wrong ENCRYPTION_KEY or corrupted data)");
  }
}

/** URL-safe random token, e.g. per-client webhook tokens. 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
