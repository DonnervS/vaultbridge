import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { ConflictSession } from "../src/conflicts/session";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(13);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 3, mime: "text/markdown", isBinary: false };

describe("Integration: Konflikt lösen", () => {
  it("erkennt Konflikt, mischt per Hunk und konvergiert konfliktfrei", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, keys, 1024);
    const b = new VaultStore(dbB, keys, 1024);

    await a.putFile("K.md", utf8.encode("titel\nzeile\nende"), meta);
    await dbA.replicate.to(dbB);
    // Zwei Schreibvorgänge auf A vor der Replikation: PouchDBs Gewinner-Regel
    // sortiert Konflikt-Leaves nach (deleted, pos, rev-id) — bei gleicher
    // Revisionshöhe (pos) entscheidet eine zufällige rev-id (uuid v4, kein
    // Inhaltsbezug), was hier ein Münzwurf wäre (empirisch verifiziert: ohne
    // diesen zweiten Put gewinnt A/B ca. 50/50, der Test flackert). Der
    // zusätzliche Zwischen-Commit hebt A auf eine höhere Revisionsgeneration
    // als B, wodurch A deterministisch gewinnt (pos wird vor rev-id verglichen)
    // und B zuverlässig als Konfliktversion in _conflicts landet.
    await a.putFile("K.md", utf8.encode("titel\nzeile\nende (a, zwischenstand)"), meta);
    await a.putFile("K.md", utf8.encode("titel\nLOKAL\nende"), meta);
    await b.putFile("K.md", utf8.encode("titel\nREMOTE\nende"), meta);
    await dbB.replicate.to(dbA);

    const [id] = await a.listConflicts();
    const c = await a.getConflict(id);
    const session = new ConflictSession({
      id: c!.id, path: c!.path, isBinary: c!.isBinary,
      local: { rev: c!.local.rev, bytes: c!.local.bytes },
      remote: { rev: c!.remotes[0].rev, bytes: c!.remotes[0].bytes },
    });
    // den geänderten Hunk auf remote setzen
    const changeIdx = session.hunks.filter((h) => h.kind === "change").length - 1;
    session.setDecision(changeIdx, "remote");
    await a.resolveConflict(id, c!.path, session.resultBytes(), meta, [session.pruneRev()]);

    expect((await a.listConflicts()).length).toBe(0);
    const text = utf8.decode((await a.getFile("K.md"))!.bytes);
    expect(text).toContain("REMOTE");
    expect(text).not.toContain("LOKAL");

    await dbA.destroy();
    await dbB.destroy();
  });
});
