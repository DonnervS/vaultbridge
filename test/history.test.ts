import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(9);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

async function storeWith3() {
  const keys = await deriveKeys("pw", salt, 50000);
  const store = new VaultStore(createTestPouch(), keys, 4);
  await store.putFile("x.md", utf8.encode("v1"), meta);
  await store.putFile("x.md", utf8.encode("v2"), meta);
  await store.putFile("x.md", utf8.encode("v3"), meta);
  const id = await pathId(keys.idKey, "x.md");
  return { store, id };
}

describe("Datei-Verlauf", () => {
  it("listRevisions liefert verfügbare Revisionen, neueste zuerst", async () => {
    const { store, id } = await storeWith3();
    const revs = await store.listRevisions(id);
    expect(revs.length).toBeGreaterThanOrEqual(3);
    expect(utf8.decode(revs[0].bytes)).toBe("v3"); // aktuell zuerst
    expect(utf8.decode(revs[revs.length - 1].bytes)).toBe("v1"); // älteste zuletzt
  });

  it("restoreRevision stellt einen alten Inhalt als neue Version her", async () => {
    const { store, id } = await storeWith3();
    const revs = await store.listRevisions(id);
    const oldest = revs[revs.length - 1];
    expect(utf8.decode(oldest.bytes)).toBe("v1");
    await store.restoreRevision(id, oldest.rev);
    expect(utf8.decode((await store.getFile("x.md"))!.bytes)).toBe("v1");
    // Wiederherstellung erzeugt eine neue Revision (kein Konflikt)
    expect((await store.listConflicts()).length).toBe(0);
    expect((await store.listRevisions(id)).length).toBeGreaterThanOrEqual(4);
  });

  it("listRevisions gibt leer bei unbekannter id", async () => {
    const { store } = await storeWith3();
    expect(await store.listRevisions("n:deadbeef")).toEqual([]);
  });
});
