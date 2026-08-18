import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { initialPullKey, uploadIfChanged } from "../src/store/initialSync";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(21);
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["a.md", "alpha"],
  ["ordner/b.md", "beta"],
  ["ordner/c.md", "gamma"],
];

// Bewusst UNTERSCHIEDLICHE Metadaten je Gerät: mtime/ctime/device weichen auf
// zwei Geräten immer ab. Der Upload darf sich trotzdem nur am INHALT
// orientieren — sonst lädt jedes Gerät alles neu hoch.
function metaFor(device: string, mtime: number, size: number): FileMeta {
  return { mtime, ctime: mtime, size, mime: "text/markdown", isBinary: false, device, changedAt: mtime };
}

describe("initialPullKey", () => {
  it("unterscheidet gleiche Datenbanknamen auf verschiedenen Servern", () => {
    expect(initialPullKey("https://a.example.com", "vault"))
      .not.toBe(initialPullKey("https://b.example.com", "vault"));
  });

  it("ignoriert einen abschließenden Schrägstrich", () => {
    expect(initialPullKey("https://a.example.com/", "vault"))
      .toBe(initialPullKey("https://a.example.com", "vault"));
  });
});

describe("Erstabgleich eines neuen Geräts", () => {
  it("erzeugt bei falscher Reihenfolge (Upload vor Pull) auf JEDER Datei einen Konflikt", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, keys, 1024);
    const b = new VaultStore(dbB, keys, 1024);

    for (const [p, t] of FILES) await a.putFile(p, utf8.encode(t), metaFor("A", 1000, t.length));

    // Gerät B hat denselben Vault auf Platte, aber einen leeren Store —
    // und lädt hoch, BEVOR gepullt wurde. Genau das Verhalten von 1.2.2.
    for (const [p, t] of FILES) await uploadIfChanged(b, p, utf8.encode(t), metaFor("B", 2000, t.length));
    await dbA.replicate.to(dbB);

    expect((await b.listConflicts()).length).toBe(FILES.length);

    await dbA.destroy();
    await dbB.destroy();
  });

  it("erzeugt bei richtiger Reihenfolge (Pull vor Upload) keinen einzigen Konflikt", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, keys, 1024);
    const b = new VaultStore(dbB, keys, 1024);

    for (const [p, t] of FILES) await a.putFile(p, utf8.encode(t), metaFor("A", 1000, t.length));

    await dbA.replicate.to(dbB); // Erst-Pull

    let written = 0;
    for (const [p, t] of FILES) {
      if (await uploadIfChanged(b, p, utf8.encode(t), metaFor("B", 2000, t.length))) written++;
    }
    expect(written).toBe(0); // identischer Inhalt trotz abweichender Metadaten

    await dbB.replicate.to(dbA);
    expect((await b.listConflicts()).length).toBe(0);
    expect((await a.listConflicts()).length).toBe(0);

    await dbA.destroy();
    await dbB.destroy();
  });

  it("lädt nach dem Erst-Pull genau die lokal abweichende Datei hoch", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, keys, 1024);
    const b = new VaultStore(dbB, keys, 1024);

    for (const [p, t] of FILES) await a.putFile(p, utf8.encode(t), metaFor("A", 1000, t.length));
    await dbA.replicate.to(dbB);

    const written: string[] = [];
    for (const [p, t] of FILES) {
      const text = p === "a.md" ? "alpha (auf B geändert)" : t;
      if (await uploadIfChanged(b, p, utf8.encode(text), metaFor("B", 2000, text.length))) written.push(p);
    }
    expect(written).toEqual(["a.md"]);

    await dbB.replicate.to(dbA);
    expect((await a.listConflicts()).length).toBe(0);
    expect(utf8.decode((await a.getFile("a.md"))!.bytes)).toBe("alpha (auf B geändert)");

    await dbA.destroy();
    await dbB.destroy();
  });
});
