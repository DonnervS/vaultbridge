import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(31);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 3, mime: "text/markdown", isBinary: false };

async function makeConflict() {
  const keys = await deriveKeys("pw", salt, 50000);
  const dbA = createTestPouch();
  const dbB = createTestPouch();
  const a = new VaultStore(dbA, keys, 1024);
  const b = new VaultStore(dbB, keys, 1024);

  await a.putFile("K.md", utf8.encode("start"), meta);
  await dbA.replicate.to(dbB);
  // Zwei Puts auf A heben A auf eine höhere Revisionsgeneration, damit A
  // deterministisch gewinnt und B verlässlich in _conflicts landet (vgl. der
  // Kommentar in conflictIntegration.test.ts).
  await a.putFile("K.md", utf8.encode("zwischenstand"), meta);
  await a.putFile("K.md", utf8.encode("aus A"), meta);
  await b.putFile("K.md", utf8.encode("aus B"), meta);
  await dbB.replicate.to(dbA);
  return { a, dbA, dbB };
}

describe("pruneConflictRevs", () => {
  it("entfernt den Konfliktzweig, ohne eine neue Revision zu schreiben", async () => {
    const { a, dbA, dbB } = await makeConflict();
    const [id] = await a.listConflicts();
    const before = await a.getConflict(id);
    const revBefore = before!.local.rev;

    await a.pruneConflictRevs(id, before!.remotes.map((r) => r.rev));

    expect((await a.listConflicts()).length).toBe(0);
    expect(utf8.decode((await a.getFile("K.md"))!.bytes)).toBe("aus A");
    // Kein Neuschreiben: die Revision des Gewinners ist unverändert.
    const after = await a.readNote(id);
    expect(after).not.toBeNull();
    const doc = await dbA.get(id);
    expect((doc as { _rev: string })._rev).toBe(revBefore);

    await dbA.destroy();
    await dbB.destroy();
  });

  it("ist idempotent — ein zweiter Aufruf wirft nicht", async () => {
    const { a, dbA, dbB } = await makeConflict();
    const [id] = await a.listConflicts();
    const revs = (await a.getConflict(id))!.remotes.map((r) => r.rev);

    await a.pruneConflictRevs(id, revs);
    await expect(a.pruneConflictRevs(id, revs)).resolves.toBeUndefined();

    await dbA.destroy();
    await dbB.destroy();
  });

  it("meldet deleted je Konfliktzweig", async () => {
    const { a, dbA, dbB } = await makeConflict();
    const [id] = await a.listConflicts();
    const c = await a.getConflict(id);
    expect(c!.local.deleted).toBe(false);
    expect(c!.remotes[0].deleted).toBe(false);

    await dbA.destroy();
    await dbB.destroy();
  });
});
