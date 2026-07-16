import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "../src/crypto/rotation";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };
function syncOnce(a: PouchDB.Database, b: PouchDB.Database) {
  return new Promise<void>((res, rej) => a.sync(b).on("complete", () => res()).on("error", rej));
}

describe("Integration: Zwei-Geräte-Rotation", () => {
  it("Gerät A rotiert; Gerät B übernimmt die neue Passphrase und liest die Dateien", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const newSalt = new Uint8Array(16).fill(2);
    const kNew = await deriveKeys("neu", newSalt, 50000);

    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, kOld, 64);
    const b = new VaultStore(dbB, kOld, 64);

    await a.putFile("Geheim.md", utf8.encode("Inhalt"), meta);
    await syncOnce(dbA, dbB);
    expect(utf8.decode((await b.getFile("Geheim.md"))!.bytes)).toBe("Inhalt");

    // A rotiert + schreibt Marker
    await a.rotate(kNew);
    const token = await makeVerifyToken(kNew, 1);
    await a.writeEpochMarker({ epoch: 1, kdfSalt: "salt", kdfIter: 50000, verify: token });
    await syncOnce(dbA, dbB);

    // B: Adoption erkennen + verifizieren + übernehmen
    const marker = await b.readEpochMarker();
    expect(needsAdoption(0, marker)).toBe(true);
    expect(await checkVerifyToken(kNew, marker!.epoch, marker!.verify)).toBe(true);
    b.setKeys(kNew, kOld);

    // B liest die (mit neuem Schlüssel, neuer id) rotierte Datei
    expect(utf8.decode((await b.getFile("Geheim.md"))!.bytes)).toBe("Inhalt");
    await dbA.destroy();
    await dbB.destroy();
  });
});
