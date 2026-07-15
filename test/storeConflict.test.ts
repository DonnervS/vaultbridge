import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(5);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false };

async function forceConflict() {
  const keys = await deriveKeys("pw", salt, 50000);
  const dbA = createTestPouch();
  const dbB = createTestPouch();
  const a = new VaultStore(dbA, keys, 64);
  const b = new VaultStore(dbB, keys, 64);
  await a.putFile("K.md", utf8.encode("basis"), meta);
  await dbA.replicate.to(dbB);
  await a.putFile("K.md", utf8.encode("lokal A"), meta);
  await b.putFile("K.md", utf8.encode("remote B"), meta);
  await dbB.replicate.to(dbA); // dbA hat jetzt den Konflikt
  return { keys, dbA, a };
}

describe("Store-Konflikt-API", () => {
  it("getConflict liefert lokale + entfernte entschlüsselte Versionen", async () => {
    const { a } = await forceConflict();
    const [id] = await a.listConflicts();
    const c = await a.getConflict(id);
    expect(c).not.toBeNull();
    expect(c!.path).toBe("K.md");
    expect(c!.isBinary).toBe(false);
    const texts = [utf8.decode(c!.local.bytes), ...c!.remotes.map((r) => utf8.decode(r.bytes))];
    expect(texts.sort()).toEqual(["lokal A", "remote B"].sort());
    expect(c!.remotes.length).toBe(1);
  });

  it("getConflict gibt null bei konfliktfreier Note", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const store = new VaultStore(createTestPouch(), keys, 64);
    await store.putFile("ok.md", utf8.encode("x"), meta);
    const { pathId } = await import("../src/crypto/crypto");
    const id = await pathId(keys.idKey, "ok.md");
    expect(await store.getConflict(id)).toBeNull();
  });

  it("resolveConflict schreibt Merge und beseitigt den Konflikt", async () => {
    const { a } = await forceConflict();
    const [id] = await a.listConflicts();
    const c = await a.getConflict(id);
    const merged = utf8.encode("lokal A + remote B");
    await a.resolveConflict(id, c!.path, merged, meta, c!.remotes.map((r) => r.rev));
    expect((await a.listConflicts()).length).toBe(0);
    expect(utf8.decode((await a.getFile("K.md"))!.bytes)).toBe("lokal A + remote B");
  });

  it("readNoteRev entschlüsselt eine bestimmte Revision", async () => {
    const { a } = await forceConflict();
    const [id] = await a.listConflicts();
    const c = await a.getConflict(id);
    const got = await a.readNoteRev(id, c!.remotes[0].rev);
    expect(utf8.decode(got!.bytes)).toBe(utf8.decode(c!.remotes[0].bytes));
  });
});
