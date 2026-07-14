import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(7);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false };

async function makeStore() {
  const keys = await deriveKeys("pw", salt, 50000);
  return new VaultStore(createTestPouch(), keys, 4);
}

describe("VaultStore", () => {
  it("schreibt und liest eine Datei", async () => {
    const store = await makeStore();
    await store.putFile("Notiz.md", utf8.encode("abcdef"), meta);
    const got = await store.getFile("Notiz.md");
    expect(got).not.toBeNull();
    expect(utf8.decode(got!.bytes)).toBe("abcdef");
  });

  it("überschreibt eine bestehende Datei (neue Revision, kein Konflikt)", async () => {
    const store = await makeStore();
    await store.putFile("Notiz.md", utf8.encode("v1"), meta);
    await store.putFile("Notiz.md", utf8.encode("v2neu"), meta);
    const got = await store.getFile("Notiz.md");
    expect(utf8.decode(got!.bytes)).toBe("v2neu");
    expect((await store.listConflicts()).length).toBe(0);
  });

  it("löscht eine Datei (getFile -> null)", async () => {
    const store = await makeStore();
    await store.putFile("Notiz.md", utf8.encode("abc"), meta);
    await store.deleteFile("Notiz.md");
    expect(await store.getFile("Notiz.md")).toBeNull();
  });

  it("readNote entschlüsselt Pfad + Inhalt anhand der _id", async () => {
    const { deriveKeys } = await import("../src/crypto/crypto");
    const { pathId } = await import("../src/crypto/crypto");
    const keys = await deriveKeys("pw", salt, 50000);
    const store = new VaultStore(createTestPouch(), keys, 4);
    await store.putFile("Unter/Datei.md", utf8.encode("inhalt"), meta);
    const id = await pathId(keys.idKey, "Unter/Datei.md");
    const note = await store.readNote(id);
    expect(note).not.toBeNull();
    expect(note!.path).toBe("Unter/Datei.md");
    expect(utf8.decode(note!.bytes)).toBe("inhalt");
    expect(note!.deleted).toBe(false);
  });

  it("readNote meldet gelöschte Note mit deleted:true und leerem Inhalt", async () => {
    const { deriveKeys, pathId } = await import("../src/crypto/crypto");
    const keys = await deriveKeys("pw", salt, 50000);
    const store = new VaultStore(createTestPouch(), keys, 4);
    await store.putFile("weg.md", utf8.encode("x"), meta);
    await store.deleteFile("weg.md");
    const id = await pathId(keys.idKey, "weg.md");
    const note = await store.readNote(id);
    expect(note!.deleted).toBe(true);
    expect(note!.path).toBe("weg.md");
    expect(note!.bytes.length).toBe(0);
  });

  it("schreibt existierende Chunks nicht neu (Dedup über Puts)", async () => {
    const store = await makeStore();
    await store.putFile("a.md", utf8.encode("gleich!!"), meta);
    // gleiche Inhalte -> gleiche Chunk-ids; darf keinen Chunk-Konflikt/-Fehler erzeugen
    await store.putFile("b.md", utf8.encode("gleich!!"), meta);
    expect(utf8.decode((await store.getFile("b.md"))!.bytes)).toBe("gleich!!");
  });
});
