import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { contentHash } from "../src/vault/applyChange";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(9);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false };

async function makeStore() {
  const keys = await deriveKeys("pw", salt, 50000);
  return new VaultStore(createTestPouch(), keys, 4);
}

describe("VaultStore.pathHashes", () => {
  it("liefert Pfad->Inhalts-Hash für alle aktiven Notes", async () => {
    const store = await makeStore();
    await store.putFile("a.md", utf8.encode("inhalt a"), meta);
    await store.putFile(".claude/config.json", utf8.encode("inhalt b"), meta);

    const hashes = await store.pathHashes();
    expect(hashes.size).toBe(2);
    expect(hashes.get("a.md")).toBe(await contentHash(utf8.encode("inhalt a")));
    expect(hashes.get(".claude/config.json")).toBe(await contentHash(utf8.encode("inhalt b")));
    // stabil über wiederholten Aufruf
    expect((await store.pathHashes()).get("a.md")).toBe(hashes.get("a.md"));
  });

  it("gelöschte Datei fehlt in pathHashes", async () => {
    const store = await makeStore();
    await store.putFile("weg.md", utf8.encode("x"), meta);
    await store.putFile("bleibt.md", utf8.encode("y"), meta);
    await store.deleteFile("weg.md");

    const hashes = await store.pathHashes();
    expect(hashes.has("weg.md")).toBe(false);
    expect(hashes.has("bleibt.md")).toBe(true);
  });
});
