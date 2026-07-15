import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { startSync } from "../src/store/replication";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(11);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 3, mime: "text/markdown", isBinary: false };

function syncOnce(a: PouchDB.Database, b: PouchDB.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    a.sync(b).on("complete", () => resolve()).on("error", reject);
  });
}

describe("Integration: verschlüsselter Zwei-Geräte-Sync", () => {
  it("überträgt eine verschlüsselte Datei von Gerät A nach B und dekodiert sie", async () => {
    const keys = await deriveKeys("gemeinsame-passphrase", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const storeA = new VaultStore(dbA, keys, 4);
    const storeB = new VaultStore(dbB, keys, 4);

    await storeA.putFile("Geheim.md", utf8.encode("streng geheim"), meta);
    await syncOnce(dbA, dbB);

    const onB = await storeB.getFile("Geheim.md");
    expect(onB).not.toBeNull();
    expect(utf8.decode(onB!.bytes)).toBe("streng geheim");

    // Der Remote-Server (dbB als Rohdaten) enthält keinen Klartext.
    const raw = await dbB.allDocs({ include_docs: true });
    expect(JSON.stringify(raw.rows)).not.toContain("streng geheim");
    expect(JSON.stringify(raw.rows)).not.toContain("Geheim.md");

    await dbA.destroy();
    await dbB.destroy();
  });

  it("erkennt einen echten Konflikt (gleiche Datei auf beiden Geräten geändert)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const storeA = new VaultStore(dbA, keys, 64);
    const storeB = new VaultStore(dbB, keys, 64);

    await storeA.putFile("K.md", utf8.encode("basis"), meta);
    await syncOnce(dbA, dbB);

    // divergente Änderungen ohne zwischenzeitlichen Sync
    await storeA.putFile("K.md", utf8.encode("variante A"), meta);
    await storeB.putFile("K.md", utf8.encode("variante B"), meta);
    await syncOnce(dbA, dbB);

    const conflictsA = await storeA.listConflicts();
    expect(conflictsA.length).toBe(1);
    await dbA.destroy();
    await dbB.destroy();
  });
});
