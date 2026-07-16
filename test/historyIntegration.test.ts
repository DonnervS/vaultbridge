import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(21);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false };

describe("Integration: Verlauf + Wiederherstellung", () => {
  it("mehrere Bearbeitungen ergeben eine Historie; Wiederherstellen setzt den Inhalt zurück und bewahrt die Historie", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const store = new VaultStore(createTestPouch(), keys, 1024);
    await store.putFile("Tag.md", utf8.encode("Montag"), meta);
    await store.putFile("Tag.md", utf8.encode("Dienstag"), meta);
    await store.putFile("Tag.md", utf8.encode("Mittwoch"), meta);
    const id = await pathId(keys.idKey, "Tag.md");

    const before = await store.listRevisions(id);
    expect(before.map((r) => utf8.decode(r.bytes))).toEqual(["Mittwoch", "Dienstag", "Montag"]);

    // "Montag" (älteste) wiederherstellen
    await store.restoreRevision(id, before[before.length - 1].rev);
    expect(utf8.decode((await store.getFile("Tag.md"))!.bytes)).toBe("Montag");

    const after = await store.listRevisions(id);
    expect(utf8.decode(after[0].bytes)).toBe("Montag"); // neue aktuelle Version
    expect(after.length).toBe(before.length + 1); // Historie um eine Version gewachsen
    // frühere Versionen bleiben abrufbar
    expect(after.map((r) => utf8.decode(r.bytes))).toContain("Mittwoch");
  });
});
