import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

describe("Zwei-Schlüssel-Ring", () => {
  it("liest ein mit dem vorherigen Schlüssel geschriebenes Doc nach id", async () => {
    const kA = await deriveKeys("altA", new Uint8Array(16).fill(1), 50000);
    const kB = await deriveKeys("neuB", new Uint8Array(16).fill(2), 50000);
    const db = createTestPouch();
    const storeA = new VaultStore(db, kA, 4);
    await storeA.putFile("x.md", utf8.encode("geheim"), meta);
    const idA = await pathId(kA.idKey, "x.md");

    // Store mit aktuellem kB, vorherigem kA -> readNoteRev/getConflict nach idA lesen kA-Docs
    const storeB = new VaultStore(db, kB, 4, kA);
    // aktuelle Revision von idA lesen:
    const revs = await storeB.listRevisions(idA);
    expect(revs.length).toBeGreaterThanOrEqual(1);
    expect(utf8.decode(revs[0].bytes)).toBe("geheim"); // via vorherigem Schlüssel
  });

  it("ohne vorherigen Schlüssel scheitert das Entschlüsseln kontrolliert (null/leer)", async () => {
    const kA = await deriveKeys("altA", new Uint8Array(16).fill(1), 50000);
    const kB = await deriveKeys("neuB", new Uint8Array(16).fill(2), 50000);
    const db = createTestPouch();
    await new VaultStore(db, kA, 4).putFile("x.md", utf8.encode("geheim"), meta);
    const idA = await pathId(kA.idKey, "x.md");
    const storeB = new VaultStore(db, kB, 4); // kein previous
    expect(await storeB.listRevisions(idA)).toEqual([]); // nicht entschlüsselbar -> übersprungen
  });
});
