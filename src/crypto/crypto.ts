import { utf8, bytesToHex } from "./encoding";

export interface VaultKeys {
  contentKey: CryptoKey; // AES-GCM
  idKey: CryptoKey;      // HMAC-SHA256
  vaultSalt: Uint8Array; // Salt für Chunk-Hashes (späterer Meilenstein)
}

const CRYPTO_VERSION = 1;

// TypeScript 5.9 typisiert Uint8Array generisch über den Puffertyp
// (Default: ArrayBufferLike), während die WebCrypto-Typen (BufferSource)
// konkret ArrayBuffer-gestützte Puffer verlangen. Eigene, frisch erzeugte
// Uint8Arrays sind zur Laufzeit immer ArrayBuffer-gestützt (nie
// SharedArrayBuffer) — dieser Cast ist rein für den Compiler, ändert am
// Verhalten nichts.
function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  iterations = 210000,
): Promise<VaultKeys> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    asBuffer(utf8.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const masterBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: asBuffer(salt), iterations, hash: "SHA-256" },
    baseKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    masterBits,
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );
  const empty = new Uint8Array(0);
  const contentKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asBuffer(empty), info: asBuffer(utf8.encode("vaultbridge:content")) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asBuffer(empty), info: asBuffer(utf8.encode("vaultbridge:id")) },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const vaultSaltBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: asBuffer(empty), info: asBuffer(utf8.encode("vaultbridge:chunksalt")) },
    hkdfKey,
    256,
  );
  return { contentKey, idKey, vaultSalt: new Uint8Array(vaultSaltBits) };
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, asBuffer(plaintext)),
  );
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = CRYPTO_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return out;
}

export async function decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob[0] !== CRYPTO_VERSION) {
    throw new Error(`Nicht unterstützte Krypto-Version: ${blob[0]}`);
  }
  const iv = asBuffer(blob.subarray(1, 13));
  const ct = asBuffer(blob.subarray(13));
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

export async function pathId(idKey: CryptoKey, path: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", idKey, asBuffer(utf8.encode(path))));
  return "n:" + bytesToHex(mac);
}
