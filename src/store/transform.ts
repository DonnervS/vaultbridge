import { VaultKeys, encryptBytes, decryptBytes, pathId } from "../crypto/crypto";
import { utf8, bytesToBase64url, base64urlToBytes } from "../crypto/encoding";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";
import { splitIntoChunks, joinChunks, chunkId } from "./chunker";

async function encField(keys: VaultKeys, plaintext: Uint8Array): Promise<string> {
  return bytesToBase64url(await encryptBytes(keys.contentKey, plaintext));
}

async function decField(keys: VaultKeys, field: string): Promise<Uint8Array> {
  return decryptBytes(keys.contentKey, base64urlToBytes(field));
}

export async function encodeFile(
  keys: VaultKeys,
  path: string,
  bytes: Uint8Array,
  meta: FileMeta,
  chunkSize: number,
): Promise<{ note: NoteDoc; chunks: ChunkDoc[] }> {
  const parts = splitIntoChunks(bytes, chunkSize);
  const chunkIds: string[] = [];
  const chunks: ChunkDoc[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const id = await chunkId(keys.vaultSalt, part);
    chunkIds.push(id);
    if (!seen.has(id)) {
      seen.add(id);
      chunks.push({ _id: id, type: "chunk", data_enc: await encField(keys, part) });
    }
  }
  const note: NoteDoc = {
    _id: await pathId(keys.idKey, path),
    type: "note",
    path_enc: await encField(keys, utf8.encode(path)),
    meta_enc: await encField(keys, utf8.encode(JSON.stringify(meta))),
    chunks: chunkIds,
  };
  return { note, chunks };
}

export async function decodeFile(
  keys: VaultKeys,
  note: NoteDoc,
  getChunk: (id: string) => Promise<ChunkDoc>,
): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta }> {
  const path = utf8.decode(await decField(keys, note.path_enc));
  const meta = JSON.parse(utf8.decode(await decField(keys, note.meta_enc))) as FileMeta;
  const parts: Uint8Array[] = [];
  for (const id of note.chunks) {
    const chunk = await getChunk(id);
    parts.push(await decField(keys, chunk.data_enc));
  }
  return { path, bytes: joinChunks(parts), meta };
}
