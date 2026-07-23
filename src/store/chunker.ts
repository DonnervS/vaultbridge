import { bytesToHex } from "../crypto/encoding";

export function splitIntoChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return chunks;
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function chunkId(vaultSalt: Uint8Array, chunk: Uint8Array): Promise<string> {
  const buf = new Uint8Array(chunk.length + vaultSalt.length);
  buf.set(chunk, 0);
  buf.set(vaultSalt, chunk.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return "h:" + bytesToHex(digest);
}
