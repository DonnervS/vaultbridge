# Vaultbridge — Meilenstein 2: Kern-Sync-Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Echter Ende-zu-Ende-verschlüsselter Sync eines Obsidian-Vaults gegen CouchDB — lokaler PouchDB-Speicher mit verschlüsseltem Dokument-/Chunk-Modell, Replikation, Vault-Brücke und Statusanzeige.

**Architecture:** Auf dem M1-Fundament (crypto/setup) baut M2 die Sync-Schichten: `store/` kapselt PouchDB + ein verschlüsseltes Note-/Chunk-Dokumentmodell (`transform/`, `chunker`), `replication/` fährt Live-/Manuell-Sync gegen CouchDB, `vault/` verbindet Obsidian-Dateiereignisse mit dem Store (mit Echo-Guard). PouchDB wird per Dependency-Injection übergeben — App: `pouchdb-browser`, Tests: `pouchdb-core` + Memory-Adapter — damit die gesamte Engine headless gegen zwei In-Memory-Datenbanken testbar ist.

**Tech Stack:** TypeScript, esbuild, Vitest, PouchDB (browser + core/memory), WebCrypto, Obsidian API.

## Global Constraints

- Baut auf M1-Modulen mit diesen exakten Signaturen (nicht ändern):
  - `crypto/crypto.ts`: `interface VaultKeys { contentKey: CryptoKey; idKey: CryptoKey; vaultSalt: Uint8Array }`; `deriveKeys(passphrase, salt, iterations?)`; `encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array>`; `decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array>`; `pathId(idKey: CryptoKey, path: string): Promise<string>` (liefert `"n:"+hex`).
  - `crypto/encoding.ts`: `bytesToBase64url`, `base64urlToBytes`, `bytesToHex`, `utf8.encode/decode`.
  - `setup/setupString.ts`: `SetupPayload { v; couchUrl; db; user; pass; kdfSalt; kdfIter; pp; passphrase?; opts: { obfuscatePaths; chunkSize; gzip } }`, `decodeSetup`.
- Verschlüsselung: **alle** Inhalte/Pfade/Metadaten über `encryptBytes`/`decryptBytes` (AES-256-GCM). Der Server sieht nur Ciphertext, HMAC-`_id`s und Strukturfelder.
- Dokument-`_id`: Note = `pathId(idKey, path)` (`n:…`); Chunk = `"h:"+hex(SHA-256(chunkBytes ++ vaultSalt))`. Deterministisch → Konflikterkennung pro Pfad, Dedup pro Chunk.
- Chunk-Verschlüsselung nutzt frischen IV → **existierende Chunks nie neu schreiben** (sonst unnötige Revisions/Churn): vor dem Put per `get` prüfen.
- Nur Web-APIs + Obsidian-API + PouchDB in `src/` — keine Node-only-Module. PouchDB per Injection, damit `src/store` env-agnostisch bleibt.
- Echo-Guard: eine gerade aus der Remote angewandte Vault-Schreibung darf kein neues lokales Änderungs-Event auslösen (Endlosschleife vermeiden) — via Pfad+Inhalts-Hash-Merker.
- TypeScript 5.9 `Uint8Array`/`BufferSource`-Regression: bei direkten WebCrypto-Aufrufen denselben `asBuffer`-Cast wie in `crypto.ts` verwenden.
- TDD, häufige Commits, DRY, YAGNI. Deutsche UI-Strings.
- Arbeitsverzeichnis: `23 obsidian-sync/vaultbridge/`.

---

## Dateistruktur (Meilenstein 2)

```
src/store/
  pouch.ts          # App-PouchDB (pouchdb-browser) + Typen
  model.ts          # NoteDoc/ChunkDoc/FileMeta-Typen
  chunker.ts        # splitIntoChunks / joinChunks / chunkId
  transform.ts      # encodeFile / decodeFile (Klartext <-> verschlüsselte Docs)
  store.ts          # VaultStore: putFile/getFile/deleteFile/listConflicts (auf PouchDB)
  replication.ts    # startSync: Live/Manuell, Status-Events, Backoff
src/vault/
  applyChange.ts    # reine Logik: Remote-Änderung -> Vault-Aktion + Echo-Guard (testbar)
  bridge.ts         # Obsidian-Verdrahtung: Vault-Events <-> Store
test/helpers/
  pouch.ts          # createTestPouch() (pouchdb-core + memory + replication)
test/
  chunker.test.ts  transform.test.ts  store.test.ts
  replication.test.ts  applyChange.test.ts  integration.test.ts
```

**Verantwortlichkeiten:** `chunker`/`transform`/`model` sind rein und ohne PouchDB testbar. `store` kapselt eine injizierte PouchDB-Instanz. `replication` kennt nur PouchDB. `vault/applyChange` ist reine Entscheidungslogik (testbar mit Fake-Vault); `vault/bridge` macht nur die Obsidian-Verdrahtung.

---

## Task 1: PouchDB-Abhängigkeiten & Build-Entschärfung

**Files:**
- Modify: `package.json` (Dependencies), `esbuild.config.mjs` (falls Shims nötig)
- Create: `src/store/pouch.ts`, `test/helpers/pouch.ts`, `test/pouch-smoke.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `src/store/pouch.ts` exportiert `PouchDB` (browser-Build) und `export type PouchDatabase = PouchDB.Database;`. `test/helpers/pouch.ts` exportiert `createTestPouch(name?): PouchDB.Database` (Memory-Adapter) und `PouchDB`.

- [ ] **Step 1: Abhängigkeiten hinzufügen**

Run:
```bash
cd "23 obsidian-sync/vaultbridge"
npm install --save pouchdb-browser
npm install --save-dev pouchdb-core pouchdb-adapter-memory pouchdb-replication @types/pouchdb @types/pouchdb-browser
```
Expected: Installation ohne Fehler.

- [ ] **Step 2: App-PouchDB-Modul anlegen**

`src/store/pouch.ts`:
```ts
import PouchDB from "pouchdb-browser";

export { PouchDB };
export type PouchDatabase = PouchDB.Database;
```

- [ ] **Step 3: Test-PouchDB-Helfer anlegen**

`test/helpers/pouch.ts`:
```ts
import PouchDB from "pouchdb-core";
import memory from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";

PouchDB.plugin(memory).plugin(replication);

let counter = 0;

export function createTestPouch(name?: string): PouchDB.Database {
  return new PouchDB(name ?? `vb-test-${counter++}`, { adapter: "memory" });
}

export { PouchDB };
```

- [ ] **Step 4: Smoke-Test schreiben**

`test/pouch-smoke.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { createTestPouch } from "./helpers/pouch";

describe("pouchdb memory adapter", () => {
  it("legt ein Dokument an und liest es zurück", async () => {
    const db = createTestPouch();
    await db.put({ _id: "x", value: 42 });
    const doc = await db.get<{ value: number }>("x");
    expect(doc.value).toBe(42);
    await db.destroy();
  });

  it("repliziert zwischen zwei In-Memory-DBs", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    await a.put({ _id: "doc1", n: 1 });
    await a.replicate.to(b);
    const got = await b.get<{ n: number }>("doc1");
    expect(got.n).toBe(1);
    await a.destroy();
    await b.destroy();
  });
});
```

- [ ] **Step 5: Test ausführen (Memory-Adapter verifizieren)**

Run: `npx vitest run test/pouch-smoke.test.ts`
Expected: PASS (2 Tests). Falls ein `global is not defined`-Fehler auftritt, füge in `vitest.config.ts` nichts hinzu (Node hat `global`); das betrifft nur den Browser-Build in Step 6.

- [ ] **Step 6: App-Bundle mit PouchDB bauen (Bundling-Risiko entschärfen)**

Run: `npm run build`
Expected: `tsc --noEmit` und esbuild erzeugen `main.js` ohne Fehler.

Falls esbuild-/Laufzeit-typische PouchDB-Probleme auftreten (`global is not defined`, `process is not defined`), ergänze in `esbuild.config.mjs` im `esbuild.context({...})`-Objekt:
```js
  define: { global: "globalThis", "process.env.NODE_ENV": production ? '"production"' : '"development"' },
```
und baue erneut. Nutze KEINE Node-Polyfill-Plugins — `pouchdb-browser` ist bereits browser-fertig; `define` genügt erfahrungsgemäß.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/store/pouch.ts test/helpers/pouch.ts test/pouch-smoke.test.ts esbuild.config.mjs
git commit -m "feat(store): PouchDB einbinden (browser + memory für Tests), Bundling verifiziert"
```

---

## Task 2: Dokumentmodell & Chunking

**Files:**
- Create: `src/store/model.ts`, `src/store/chunker.ts`
- Test: `test/chunker.test.ts`

**Interfaces:**
- Consumes: `bytesToHex` (`crypto/encoding`).
- Produces:
  - `model.ts`: `interface FileMeta { mtime: number; ctime: number; size: number; mime: string; isBinary: boolean }`; `interface NoteDoc { _id: string; _rev?: string; type: "note"; path_enc: string; meta_enc: string; chunks: string[]; deleted?: boolean }`; `interface ChunkDoc { _id: string; _rev?: string; type: "chunk"; data_enc: string }`.
  - `chunker.ts`: `splitIntoChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[]`; `joinChunks(chunks: Uint8Array[]): Uint8Array`; `chunkId(vaultSalt: Uint8Array, chunk: Uint8Array): Promise<string>` (liefert `"h:"+hex`).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/chunker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitIntoChunks, joinChunks, chunkId } from "../src/store/chunker";

const salt = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);

describe("chunker", () => {
  it("splittet und fügt wieder zusammen (exakt teilbar)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chunks = splitIntoChunks(data, 2);
    expect(chunks.length).toBe(3);
    expect([...joinChunks(chunks)]).toEqual([...data]);
  });

  it("splittet mit Rest korrekt", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = splitIntoChunks(data, 2);
    expect(chunks.length).toBe(3);
    expect([...chunks[2]]).toEqual([5]);
    expect([...joinChunks(chunks)]).toEqual([...data]);
  });

  it("leere Eingabe ergibt keinen Chunk", () => {
    expect(splitIntoChunks(new Uint8Array(0), 4).length).toBe(0);
  });

  it("chunkId ist deterministisch, inhaltsabhängig und salt-abhängig", async () => {
    const c = new Uint8Array([1, 2, 3]);
    const id1 = await chunkId(salt, c);
    const id2 = await chunkId(salt, new Uint8Array([1, 2, 3]));
    const id3 = await chunkId(salt, new Uint8Array([1, 2, 4]));
    const id4 = await chunkId(new Uint8Array(16), c);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toBe(id4);
    expect(id1.startsWith("h:")).toBe(true);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/chunker.test.ts`
Expected: FAIL (Module fehlen).

- [ ] **Step 3: Modell + Chunker implementieren**

`src/store/model.ts`:
```ts
export interface FileMeta {
  mtime: number;
  ctime: number;
  size: number;
  mime: string;
  isBinary: boolean;
}

export interface NoteDoc {
  _id: string;
  _rev?: string;
  type: "note";
  path_enc: string;
  meta_enc: string;
  chunks: string[];
  deleted?: boolean;
}

export interface ChunkDoc {
  _id: string;
  _rev?: string;
  type: "chunk";
  data_enc: string;
}
```

`src/store/chunker.ts`:
```ts
import { bytesToHex } from "../crypto/encoding";

export function splitIntoChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return chunks;
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function chunkId(vaultSalt: Uint8Array, chunk: Uint8Array): Promise<string> {
  const buf = new Uint8Array(chunk.length + vaultSalt.length);
  buf.set(chunk, 0);
  buf.set(vaultSalt, chunk.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf as Uint8Array<ArrayBuffer>));
  return "h:" + bytesToHex(digest);
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/chunker.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/model.ts src/store/chunker.ts test/chunker.test.ts
git commit -m "feat(store): Dokumentmodell (Note/Chunk) + Chunking mit salt-basiertem Dedup-Hash"
```

---

## Task 3: Transform-Schicht (Klartext ↔ verschlüsselte Docs)

**Files:**
- Create: `src/store/transform.ts`
- Test: `test/transform.test.ts`

**Interfaces:**
- Consumes: `VaultKeys`, `encryptBytes`, `decryptBytes`, `pathId` (`crypto/crypto`); `utf8`, `bytesToBase64url`, `base64urlToBytes` (`crypto/encoding`); `NoteDoc`, `ChunkDoc`, `FileMeta` (`store/model`); `splitIntoChunks`, `joinChunks`, `chunkId` (`store/chunker`).
- Produces:
  - `encodeFile(keys: VaultKeys, path: string, bytes: Uint8Array, meta: FileMeta, chunkSize: number): Promise<{ note: NoteDoc; chunks: ChunkDoc[] }>`
  - `decodeFile(keys: VaultKeys, note: NoteDoc, getChunk: (id: string) => Promise<ChunkDoc>): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta }>`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/transform.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { encodeFile, decodeFile } from "../src/store/transform";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(3);
const meta: FileMeta = { mtime: 1000, ctime: 500, size: 11, mime: "text/markdown", isBinary: false };

describe("transform", () => {
  it("kodiert eine Datei und dekodiert sie identisch zurück", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const bytes = utf8.encode("Hallo Welt äöü");
    const { note, chunks } = await encodeFile(keys, "Ordner/Notiz.md", bytes, meta, 4);

    expect(note.type).toBe("note");
    expect(note._id.startsWith("n:")).toBe(true);
    expect(note.chunks.length).toBe(chunks.length);
    // Kein Klartext im Doc:
    expect(JSON.stringify(note)).not.toContain("Ordner");
    expect(JSON.stringify(chunks)).not.toContain("Hallo");

    const byId = new Map(chunks.map((c) => [c._id, c]));
    const decoded = await decodeFile(keys, note, async (id) => byId.get(id)!);
    expect(decoded.path).toBe("Ordner/Notiz.md");
    expect(utf8.decode(decoded.bytes)).toBe("Hallo Welt äöü");
    expect(decoded.meta).toEqual(meta);
  });

  it("gleicher Chunk-Inhalt ergibt gleiche Chunk-id (Dedup)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const bytes = new Uint8Array([1, 1, 1, 1]); // zwei identische 2-Byte-Chunks
    const { note } = await encodeFile(keys, "a.bin", bytes, meta, 2);
    expect(note.chunks[0]).toBe(note.chunks[1]);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/transform.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: Transform implementieren**

`src/store/transform.ts`:
```ts
import { VaultKeys, encryptBytes, decryptBytes, pathId } from "../crypto/crypto";
import { utf8, bytesToBase64url, base64urlToBytes } from "../crypto/encoding";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";
import { splitIntoChunks, joinChunks, chunkId } from "./chunker";

async function encField(keys: VaultKeys, plaintext: Uint8Array): Promise<string> {
  return bytesToBase64url(await encryptBytes(keys.contentKey, plaintext));
}

async function decField(keys: VaultKeys, field: string): Promise<Uint8Array> {
  return decryptBytes(keys.contentKey, base64urlToBytes(field));
}

export async function encodeFile(
  keys: VaultKeys,
  path: string,
  bytes: Uint8Array,
  meta: FileMeta,
  chunkSize: number,
): Promise<{ note: NoteDoc; chunks: ChunkDoc[] }> {
  const parts = splitIntoChunks(bytes, chunkSize);
  const chunkIds: string[] = [];
  const chunks: ChunkDoc[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const id = await chunkId(keys.vaultSalt, part);
    chunkIds.push(id);
    if (!seen.has(id)) {
      seen.add(id);
      chunks.push({ _id: id, type: "chunk", data_enc: await encField(keys, part) });
    }
  }
  const note: NoteDoc = {
    _id: await pathId(keys.idKey, path),
    type: "note",
    path_enc: await encField(keys, utf8.encode(path)),
    meta_enc: await encField(keys, utf8.encode(JSON.stringify(meta))),
    chunks: chunkIds,
  };
  return { note, chunks };
}

export async function decodeFile(
  keys: VaultKeys,
  note: NoteDoc,
  getChunk: (id: string) => Promise<ChunkDoc>,
): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta }> {
  const path = utf8.decode(await decField(keys, note.path_enc));
  const meta = JSON.parse(utf8.decode(await decField(keys, note.meta_enc))) as FileMeta;
  const parts: Uint8Array[] = [];
  for (const id of note.chunks) {
    const chunk = await getChunk(id);
    parts.push(await decField(keys, chunk.data_enc));
  }
  return { path, bytes: joinChunks(parts), meta };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/transform.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/transform.ts test/transform.test.ts
git commit -m "feat(store): Transform-Schicht (verschlüsselte Note-/Chunk-Docs <-> Klartext)"
```

---

## Task 4: VaultStore (PouchDB-Anbindung)

**Files:**
- Create: `src/store/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `PouchDatabase` (`store/pouch`, nur als Typ), `VaultKeys` (`crypto/crypto`), `pathId` (`crypto/crypto`), `encodeFile`/`decodeFile` (`store/transform`), `NoteDoc`/`ChunkDoc`/`FileMeta` (`store/model`); Tests: `createTestPouch` (`test/helpers/pouch`).
- Produces: `class VaultStore` mit:
  - `constructor(db: PouchDB.Database, keys: VaultKeys, chunkSize: number)`
  - `putFile(path: string, bytes: Uint8Array, meta: FileMeta): Promise<void>`
  - `getFile(path: string): Promise<{ bytes: Uint8Array; meta: FileMeta } | null>`
  - `deleteFile(path: string): Promise<void>`
  - `listConflicts(): Promise<string[]>` (Liste von Note-`_id`s mit Konflikten)
  - `readNote(id: string): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta; deleted: boolean } | null>` (entschlüsselt ein Note-Doc anhand seiner `_id` — für die Brücke, um eingehende Remote-Änderungen anzuwenden)
  - `subscribe(onNoteChange: (id: string) => void): { cancel(): void }` (Live-`changes`-Feed der lokalen DB, gefiltert auf Note-Docs)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/store.test.ts`:
```ts
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
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: VaultStore implementieren**

`src/store/store.ts`:
```ts
import { VaultKeys, pathId } from "../crypto/crypto";
import { encodeFile, decodeFile } from "./transform";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";

export class VaultStore {
  constructor(
    private readonly db: PouchDB.Database,
    private readonly keys: VaultKeys,
    private readonly chunkSize: number,
  ) {}

  async putFile(path: string, bytes: Uint8Array, meta: FileMeta): Promise<void> {
    const { note, chunks } = await encodeFile(this.keys, path, bytes, meta, this.chunkSize);

    // Chunks: nur neue schreiben (Dedup, Vermeidung unnötiger Revisions).
    for (const chunk of chunks) {
      const exists = await this.exists(chunk._id);
      if (!exists) {
        await this.db.put(chunk);
      }
    }

    // Note: bestehende Revision übernehmen, damit ein Update kein Konflikt wird.
    const prev = await this.getRaw<NoteDoc>(note._id);
    if (prev) {
      note._rev = prev._rev;
    }
    await this.db.put(note);
  }

  async getFile(path: string): Promise<{ bytes: Uint8Array; meta: FileMeta } | null> {
    const id = await pathId(this.keys.idKey, path);
    const note = await this.getRaw<NoteDoc>(id);
    if (!note || note.deleted) return null;
    const decoded = await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
    return { bytes: decoded.bytes, meta: decoded.meta };
  }

  async deleteFile(path: string): Promise<void> {
    const id = await pathId(this.keys.idKey, path);
    const note = await this.getRaw<NoteDoc>(id);
    if (!note) return;
    note.deleted = true;
    note.chunks = [];
    await this.db.put(note);
  }

  async listConflicts(): Promise<string[]> {
    const res = await this.db.allDocs({ include_docs: true, conflicts: true });
    const ids: string[] = [];
    for (const row of res.rows) {
      const doc = row.doc as (NoteDoc & { _conflicts?: string[] }) | undefined;
      if (doc && doc.type === "note" && doc._conflicts && doc._conflicts.length > 0) {
        ids.push(doc._id);
      }
    }
    return ids;
  }

  async readNote(
    id: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta; deleted: boolean } | null> {
    const note = await this.getRaw<NoteDoc>(id);
    if (!note) return null;
    // decodeFile entschlüsselt path_enc/meta_enc immer; bei gelöschten Notes sind
    // chunks=[] -> bytes leer. path_enc/meta_enc bleiben beim Löschen erhalten.
    const decoded = await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
    return { path: decoded.path, bytes: decoded.bytes, meta: decoded.meta, deleted: !!note.deleted };
  }

  subscribe(onNoteChange: (id: string) => void): { cancel(): void } {
    const feed = this.db.changes({ live: true, since: "now", include_docs: false });
    feed.on("change", (change) => {
      if (change.id.startsWith("n:")) onNoteChange(change.id);
    });
    return { cancel: () => feed.cancel() };
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await this.db.get(id);
      return true;
    } catch {
      return false;
    }
  }

  private async getRaw<T>(id: string): Promise<(T & { _rev: string }) | null> {
    try {
      return (await this.db.get<T>(id)) as T & { _rev: string };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/store.test.ts
git commit -m "feat(store): VaultStore auf PouchDB (put/get/delete/listConflicts, Chunk-Dedup)"
```

---

## Task 5: Replikation

**Files:**
- Create: `src/store/replication.ts`
- Test: `test/replication.test.ts`

**Interfaces:**
- Consumes: `PouchDB.Database` (Typ). Tests: `createTestPouch`.
- Produces:
  - `type SyncStatus = "idle" | "active" | "paused" | "error"`
  - `interface SyncHandle { stop(): void }`
  - `startSync(local: PouchDB.Database, remote: PouchDB.Database, opts: { live: boolean }, onStatus: (s: SyncStatus, info?: string) => void): SyncHandle`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/replication.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { startSync } from "../src/store/replication";
import { createTestPouch } from "./helpers/pouch";

describe("startSync", () => {
  it("repliziert Dokumente einmalig (live:false) und meldet idle am Ende", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    await a.put({ _id: "d1", n: 1 });
    await b.put({ _id: "d2", n: 2 });

    const statuses: string[] = [];
    await new Promise<void>((resolve) => {
      startSync(a, b, { live: false }, (s) => {
        statuses.push(s);
        if (s === "idle") resolve();
      });
    });

    // Beide Seiten haben beide Docs.
    expect((await a.get<{ n: number }>("d2")).n).toBe(2);
    expect((await b.get<{ n: number }>("d1")).n).toBe(1);
    expect(statuses).toContain("idle");
    await a.destroy();
    await b.destroy();
  });

  it("stop() bricht Live-Sync ab, ohne zu werfen", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    const handle = startSync(a, b, { live: true }, () => {});
    handle.stop();
    await a.destroy();
    await b.destroy();
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/replication.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: Replikation implementieren**

`src/store/replication.ts`:
```ts
export type SyncStatus = "idle" | "active" | "paused" | "error";

export interface SyncHandle {
  stop(): void;
}

export function startSync(
  local: PouchDB.Database,
  remote: PouchDB.Database | string,
  opts: { live: boolean },
  onStatus: (status: SyncStatus, info?: string) => void,
): SyncHandle {
  const sync = local.sync(remote, {
    live: opts.live,
    retry: opts.live, // im Live-Modus mit Backoff erneut versuchen
  });

  sync
    .on("active", () => onStatus("active"))
    .on("paused", (err?: unknown) => onStatus(err ? "error" : "paused", err ? String(err) : undefined))
    .on("change", () => onStatus("active"))
    .on("error", (err: unknown) => onStatus("error", String(err)))
    .on("complete", () => onStatus("idle"));

  return {
    stop() {
      sync.cancel();
    },
  };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/replication.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/replication.ts test/replication.test.ts
git commit -m "feat(store): Replikation (live/einmalig, Status-Events, Backoff via retry)"
```

---

## Task 6: Vault-Brücke (Änderungslogik + Echo-Guard) und Obsidian-Verdrahtung

**Files:**
- Create: `src/vault/applyChange.ts`, `src/vault/bridge.ts`
- Test: `test/applyChange.test.ts`

**Interfaces:**
- Consumes (`applyChange`): keine externen — reine Logik + ein `EchoGuard`.
- Produces:
  - `applyChange.ts`: `class EchoGuard { markApplied(path: string, hash: string): void; isEcho(path: string, hash: string): boolean }`; `contentHash(bytes: Uint8Array): Promise<string>` (SHA-256-Hex); `decideVaultAction(remote: { path: string; deleted: boolean }, existsLocally: boolean): "write" | "delete" | "noop"`.
  - `bridge.ts`: `class VaultBridge { constructor(app: App, store: VaultStore, guard: EchoGuard); start(): void; stop(): void }` — registriert Obsidian-Vault-Events (lokale Edits → Store) UND abonniert `store.subscribe` (eingehende Remote-Änderungen → Vault-Dateien) mit Echo-Guard + Inhalts-Hash-Vergleich. (Obsidian-gekoppelt, manuell verifiziert; die Entscheidungslogik ist in `applyChange.ts` unit-getestet.)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/applyChange.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { EchoGuard, contentHash, decideVaultAction } from "../src/vault/applyChange";

describe("EchoGuard", () => {
  it("erkennt eine gerade angewandte Schreibung als Echo (einmalig)", () => {
    const g = new EchoGuard();
    g.markApplied("a.md", "hash1");
    expect(g.isEcho("a.md", "hash1")).toBe(true);
    // nach dem Konsum nicht mehr als Echo gewertet
    expect(g.isEcho("a.md", "hash1")).toBe(false);
  });

  it("anderer Inhalt am selben Pfad ist kein Echo", () => {
    const g = new EchoGuard();
    g.markApplied("a.md", "hash1");
    expect(g.isEcho("a.md", "hash2")).toBe(false);
  });
});

describe("contentHash", () => {
  it("ist deterministisch und inhaltsabhängig", async () => {
    const h1 = await contentHash(new Uint8Array([1, 2, 3]));
    const h2 = await contentHash(new Uint8Array([1, 2, 3]));
    const h3 = await contentHash(new Uint8Array([1, 2, 4]));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("decideVaultAction", () => {
  it("write bei nicht gelöschtem Remote", () => {
    expect(decideVaultAction({ path: "a", deleted: false }, false)).toBe("write");
  });
  it("delete bei gelöschtem Remote, das lokal existiert", () => {
    expect(decideVaultAction({ path: "a", deleted: true }, true)).toBe("delete");
  });
  it("noop bei gelöschtem Remote, das lokal nicht existiert", () => {
    expect(decideVaultAction({ path: "a", deleted: true }, false)).toBe("noop");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/applyChange.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: `applyChange.ts` implementieren**

`src/vault/applyChange.ts`:
```ts
import { bytesToHex } from "../crypto/encoding";

/**
 * Verhindert Endlosschleifen: eine gerade aus der Remote in den Vault
 * geschriebene Datei löst ein Obsidian-"modify"-Event aus — dieses darf nicht
 * als neue lokale Änderung zurück in den Store geschrieben werden.
 */
export class EchoGuard {
  private readonly pending = new Map<string, string>();

  markApplied(path: string, hash: string): void {
    this.pending.set(path, hash);
  }

  isEcho(path: string, hash: string): boolean {
    if (this.pending.get(path) === hash) {
      this.pending.delete(path); // einmalig konsumieren
      return true;
    }
    return false;
  }
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return bytesToHex(digest);
}

export function decideVaultAction(
  remote: { path: string; deleted: boolean },
  existsLocally: boolean,
): "write" | "delete" | "noop" {
  if (remote.deleted) return existsLocally ? "delete" : "noop";
  return "write";
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/applyChange.test.ts`
Expected: PASS (7 Tests).

- [ ] **Step 5: `bridge.ts` implementieren (Obsidian-Verdrahtung, manuell verifiziert)**

`src/vault/bridge.ts`:
```ts
import { App, TAbstractFile, TFile, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { EchoGuard, contentHash, decideVaultAction } from "./applyChange";
import { FileMeta } from "../store/model";

/**
 * Verbindet Obsidian-Vault-Ereignisse mit dem VaultStore in beide Richtungen:
 *  - lokale Datei-Events  -> Store  (ausgehend)
 *  - Store-Change-Feed    -> Vault  (eingehend, aus der Replikation), mit
 *    Echo-Guard + Inhalts-Hash-Vergleich gegen Endlosschleifen/Redundanz.
 */
export class VaultBridge {
  private readonly handlers: Array<() => void> = [];
  private incoming: { cancel(): void } | null = null;

  constructor(
    private readonly app: App,
    private readonly store: VaultStore,
    private readonly guard: EchoGuard,
  ) {}

  start(): void {
    const vault = this.app.vault;

    const onLocalWrite = async (file: TFile) => {
      try {
        const bytes = new Uint8Array(await vault.readBinary(file));
        if (this.guard.isEcho(file.path, await contentHash(bytes))) return; // eigene Remote-Schreibung
        const meta: FileMeta = {
          mtime: file.stat.mtime,
          ctime: file.stat.ctime,
          size: file.stat.size,
          mime: "",
          isBinary: !/^(md|txt|json|css|ya?ml)$/i.test(file.extension),
        };
        await this.store.putFile(file.path, bytes, meta);
      } catch (e) {
        new Notice(`Vaultbridge: Sync-Fehler bei ${file.path}: ${String(e)}`);
      }
    };
    const onLocalDelete = async (file: TAbstractFile) => {
      try {
        await this.store.deleteFile(file.path);
      } catch (e) {
        new Notice(`Vaultbridge: Löschfehler bei ${file.path}: ${String(e)}`);
      }
    };

    const refCreate = vault.on("create", (f) => { if (f instanceof TFile) void onLocalWrite(f); });
    const refModify = vault.on("modify", (f) => { if (f instanceof TFile) void onLocalWrite(f); });
    const refDelete = vault.on("delete", (f) => void onLocalDelete(f));
    this.handlers.push(
      () => vault.offref(refCreate),
      () => vault.offref(refModify),
      () => vault.offref(refDelete),
    );

    // Eingehende Remote-Änderungen anwenden.
    this.incoming = this.store.subscribe((id) => void this.applyRemote(id));
  }

  private async applyRemote(id: string): Promise<void> {
    try {
      const note = await this.store.readNote(id);
      if (!note) return;
      const vault = this.app.vault;
      const existing = vault.getAbstractFileByPath(note.path);
      const action = decideVaultAction(
        { path: note.path, deleted: note.deleted },
        existing instanceof TFile,
      );
      if (action === "delete" && existing instanceof TFile) {
        await vault.delete(existing);
        return;
      }
      if (action !== "write") return;

      const targetHash = await contentHash(note.bytes);
      // Obsidians modify/createBinary erwarten ArrayBuffer; slice() liefert eine
      // exakte, offset-freie Kopie -> sicher als ArrayBuffer.
      const ab = note.bytes.slice().buffer as ArrayBuffer;
      if (existing instanceof TFile) {
        const current = new Uint8Array(await vault.readBinary(existing));
        if ((await contentHash(current)) === targetHash) return; // schon in sync (auch lokaler Ursprung)
        this.guard.markApplied(note.path, targetHash);
        await vault.modifyBinary(existing, ab);
      } else {
        this.guard.markApplied(note.path, targetHash);
        await this.ensureParent(note.path);
        await vault.createBinary(note.path, ab);
      }
    } catch (e) {
      new Notice(`Vaultbridge: Anwenden fehlgeschlagen (${id}): ${String(e)}`);
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch { /* existiert bereits */ }
      }
    }
  }

  stop(): void {
    for (const off of this.handlers) off();
    this.handlers.length = 0;
    this.incoming?.cancel();
    this.incoming = null;
  }
}
```

- [ ] **Step 6: Build prüfen**

Run: `npm run build`
Expected: `tsc` + esbuild ohne Fehler (`bridge.ts` typecheckt gegen Obsidian-Typen).

- [ ] **Step 7: Commit**

```bash
git add src/vault/applyChange.ts src/vault/bridge.ts test/applyChange.test.ts
git commit -m "feat(vault): Änderungslogik + Echo-Guard (testbar) und Obsidian-Vault-Brücke"
```

---

## Task 7: Verdrahtung in main.ts + Statusleiste

**Files:**
- Modify: `src/main.ts`
- Create: `src/ui/StatusBar.ts`

**Interfaces:**
- Consumes: `decodeSetup` (`setup/setupString`), `deriveKeys` (`crypto/crypto`), `PouchDB` (`store/pouch`), `VaultStore` (`store/store`), `startSync`/`SyncStatus` (`store/replication`), `VaultBridge`/`EchoGuard` (`vault/*`).
- Produces: `class StatusBar { setStatus(s: SyncStatus): void }`; `main.ts` startet bei gültigem Setup den Sync-Stack (Store + Replikation + Bridge) und aktualisiert die Statusleiste.

- [ ] **Step 1: StatusBar implementieren**

`src/ui/StatusBar.ts`:
```ts
import { SyncStatus } from "../store/replication";

const LABELS: Record<SyncStatus, string> = {
  idle: "🟢 Vaultbridge: aktuell",
  active: "🔵 Vaultbridge: synct …",
  paused: "🟢 Vaultbridge: bereit",
  error: "🔴 Vaultbridge: Fehler",
};

export class StatusBar {
  constructor(private readonly el: HTMLElement) {
    this.el.setText("⚪ Vaultbridge: inaktiv");
  }
  setStatus(status: SyncStatus, info?: string): void {
    this.el.setText(LABELS[status] + (status === "error" && info ? ` (${info})` : ""));
  }
}
```

- [ ] **Step 2: `main.ts` verdrahten**

Ersetze `src/main.ts` durch:
```ts
import { Notice, Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { decodeSetup } from "./setup/setupString";
import { deriveKeys } from "./crypto/crypto";
import { base64urlToBytes } from "./crypto/encoding";
import { PouchDB } from "./store/pouch";
import { VaultStore } from "./store/store";
import { startSync, SyncHandle } from "./store/replication";
import { EchoGuard } from "./vault/applyChange";
import { VaultBridge } from "./vault/bridge";
import { promptPassphrase } from "./ui/PassphrasePromptModal";

export interface VaultbridgeSettings {
  setupString: string;
  deviceName: string;
}

const DEFAULT_SETTINGS: VaultbridgeSettings = { setupString: "", deviceName: "" };

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = { ...DEFAULT_SETTINGS };
  private statusBar!: StatusBar;
  private syncHandle: SyncHandle | null = null;
  private bridge: VaultBridge | null = null;
  private localDb: PouchDB.Database | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new VaultbridgeSettingsTab(this.app, this));
    this.addCommand({ id: "vaultbridge-connect", name: "Vaultbridge: Verbinden", callback: () => this.connect() });
    this.addCommand({ id: "vaultbridge-disconnect", name: "Vaultbridge: Trennen", callback: () => this.disconnect() });
    if (this.settings.setupString) {
      // Bewusst nicht automatisch verbinden, wenn eine Passphrase-Eingabe nötig ist.
      // Der Nutzer startet den Sync über den Befehl oder Settings-Button.
    }
  }

  async onunload(): Promise<void> {
    this.disconnect();
  }

  async connect(): Promise<void> {
    try {
      const payload = decodeSetup(this.settings.setupString);
      let passphrase = payload.passphrase ?? "";
      if (payload.pp === "separate") {
        passphrase = (await promptPassphrase(this.app, "Passphrase eingeben")) ?? "";
        if (!passphrase) { new Notice("Vaultbridge: keine Passphrase, abgebrochen."); return; }
      }
      const keys = await deriveKeys(passphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
      this.localDb = new PouchDB(`vaultbridge-${payload.db}`);
      const store = new VaultStore(this.localDb, keys, payload.opts.chunkSize);
      const guard = new EchoGuard();
      this.bridge = new VaultBridge(this.app, store, guard);
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, { auth: { username: payload.user, password: payload.pass } });
      this.syncHandle = startSync(this.localDb, remote, { live: true }, (s, info) => this.statusBar.setStatus(s, info));
      new Notice("Vaultbridge verbunden.");
    } catch (e) {
      this.statusBar.setStatus("error", String(e));
      new Notice(`Vaultbridge: Verbindung fehlgeschlagen: ${String(e)}`);
    }
  }

  disconnect(): void {
    this.syncHandle?.stop();
    this.syncHandle = null;
    this.bridge?.stop();
    this.bridge = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

- [ ] **Step 3: Build prüfen**

Run: `npm run build`
Expected: `tsc` + esbuild ohne Fehler, `main.js` erzeugt.

- [ ] **Step 4: Volle Suite prüfen**

Run: `npm test`
Expected: alle Testdateien PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/ui/StatusBar.ts
git commit -m "feat: Sync-Stack in main.ts verdrahtet (Store + Replikation + Bridge) + Statusleiste"
```

---

## Task 8: Integrationstest — verschlüsselter Zwei-Geräte-Sync + Konflikt

**Files:**
- Create: `test/integration.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `startSync`, `deriveKeys`, `createTestPouch`, `utf8`, `FileMeta`.

- [ ] **Step 1: Integrationstest schreiben**

`test/integration.test.ts`:
```ts
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
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS (2 Tests). Der Konflikttest muss genau eine konfliktbehaftete Note melden.

- [ ] **Step 3: Volle Suite + Build**

Run: `npm test && npm run build`
Expected: alle Tests PASS, `main.js` erzeugt.

- [ ] **Step 4: Commit**

```bash
git add test/integration.test.ts
git commit -m "test: Integrationstest — verschlüsselter Zwei-Geräte-Sync + Konflikterkennung"
```

---

## Meilenstein-2-Abschluss

Danach existiert ein funktionierender, headless getesteter Sync-Kern: verschlüsselte Note-/Chunk-Docs, PouchDB-Store, Replikation, **bidirektionale** Vault-Brücke (lokale Edits → Store und eingehende Remote-Änderungen → Vault-Dateien) mit Echo-Guard, Statusleiste — und ein Integrationstest, der echten Zwei-Geräte-Sync inkl. Konflikterkennung nachweist. **Manuelle Verifikation offen:** echter Sync gegen eine laufende CouchDB zwischen zwei Obsidian-Instanzen.

**Noch nicht enthalten (spätere Meilensteine):** die Konflikt-Diff-UI (M3) — sie konsumiert `listConflicts()`; Dateisteuerung/Regeln, Mobile-Sync-Modi (WLAN-Gate, Intervall), QR-Onboarding, Setup-Generator (M4); Datei-Verlauf (M5); Passphrase-Rotation (M6).
