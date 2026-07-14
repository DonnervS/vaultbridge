import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { encodeFile, decodeFile } from "../src/store/transform";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(3);
const meta: FileMeta = { mtime: 1000, ctime: 500, size: 11, mime: "text/markdown", isBinary: false };

describe("transform", () => {
  it("kodiert eine Datei und dekodiert sie identisch zurück", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const bytes = utf8.encode("Hallo Welt äöü");
    const { note, chunks } = await encodeFile(keys, "Ordner/Notiz.md", bytes, meta, 4);

    expect(note.type).toBe("note");
    expect(note._id.startsWith("n:")).toBe(true);
    expect(note.chunks.length).toBe(chunks.length);
    // Kein Klartext im Doc:
    expect(JSON.stringify(note)).not.toContain("Ordner");
    expect(JSON.stringify(chunks)).not.toContain("Hallo");

    const byId = new Map(chunks.map((c) => [c._id, c]));
    const decoded = await decodeFile(keys, note, async (id) => byId.get(id)!);
    expect(decoded.path).toBe("Ordner/Notiz.md");
    expect(utf8.decode(decoded.bytes)).toBe("Hallo Welt äöü");
    expect(decoded.meta).toEqual(meta);
  });

  it("gleicher Chunk-Inhalt ergibt gleiche Chunk-id (Dedup)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const bytes = new Uint8Array([1, 1, 1, 1]); // zwei identische 2-Byte-Chunks
    const { note } = await encodeFile(keys, "a.bin", bytes, meta, 2);
    expect(note.chunks[0]).toBe(note.chunks[1]);
  });
});
