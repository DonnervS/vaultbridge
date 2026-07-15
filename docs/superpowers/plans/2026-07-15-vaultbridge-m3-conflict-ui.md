# Vaultbridge — Meilenstein 3: Konflikt-Diff-UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine zweispaltige Konflikt-Diff-Oberfläche (lokal ↔ remote) mit Übernahme pro Änderungsblock oder ganzer Datei; die Auflösung schreibt eine neue Gewinner-Revision und bereinigt die verlierenden — Binärdateien über „behalten"-Karten.

**Architecture:** Auf der M2-Sync-Engine. Der Store bekommt eine Konflikt-API (`getConflict`/`readNoteRev`/`resolveConflict` inkl. Revisions-Pruning). Ein reines, headless testbares Diff-/Merge-Modell (`conflicts/diff.ts`, Zeilen-Hunks via `diff`-Lib) und eine `ConflictSession` (`conflicts/session.ts`) kapseln die Auflöse-Logik strikt getrennt von der Darstellung. Die UI (`ui/ConflictListView`, `ui/ConflictResolverModal`) rendert eigenes zweispaltiges HTML mit Übernahme-Buttons — kein CodeMirror, kein Bundling-Risiko, mobil identisch.

**Tech Stack:** TypeScript, esbuild, Vitest, `diff` (jsdiff), PouchDB, Obsidian API.

## Global Constraints

- Baut auf M2 mit diesen exakten Signaturen (nicht ändern): `VaultStore` (`putFile/getFile/deleteFile/listConflicts/readNote/subscribe`), `NoteDoc`/`ChunkDoc`/`FileMeta` (`store/model`), `encodeFile`/`decodeFile` (`store/transform`), `VaultKeys`/`encryptBytes`/`decryptBytes`/`pathId` (`crypto/crypto`).
- Konflikt-Auflösung: Gewinner-Revision mit gemischtem Inhalt neu schreiben (bestehende `_rev` übernehmen), dann die aufgelösten verlierenden Revisionen per `db.remove(id, rev)` bereinigen → CouchDB konvergiert. Bei >2 Versionen wird nur die gerade aufgelöste Revision bereinigt (Rest bleibt als Folgekonflikt).
- Chunk-Verschlüsselung nutzt frischen IV → existierende Chunks nie neu schreiben (`get`-Prüfung, 409 tolerieren) — wie in M2.
- Auflöse-Logik (`diff.ts`, `session.ts`) und Store-API sind **headless testbar**; nur die Views sind manuell zu verifizieren.
- Nur Web-APIs + Obsidian-API + PouchDB + `diff` in `src/`. Keine Node-only-Module. Deutsche UI-Strings.
- TS 5.9 `Uint8Array`/`BufferSource`: bei direkten WebCrypto-Aufrufen denselben `asBuffer`-Cast wie in `crypto.ts`/`chunker.ts` verwenden.
- TDD, häufige Commits, DRY, YAGNI.
- Arbeitsverzeichnis: `23 obsidian-sync/vaultbridge/`.

---

## Dateistruktur (Meilenstein 3)

```
src/store/store.ts        # erweitert: readNoteRev, getConflict, resolveConflict
src/conflicts/
  diff.ts                 # computeHunks / mergedText / wholeSide (rein)
  session.ts              # ConflictSession: hält Konflikt + Hunks + Entscheidungen -> merged bytes (rein-ish)
src/ui/
  ConflictListView.ts     # ItemView: Liste konfliktbehafteter Dateien
  ConflictResolverModal.ts# zweispaltige Diff-Ansicht + Übernahme-Buttons (+ Binär-Karten)
src/main.ts               # erweitert: Konflikt-Badge, Befehl "Konflikte anzeigen"
styles.css                # Diff-Styles
test/
  storeConflict.test.ts  diff.test.ts  session.test.ts  conflictIntegration.test.ts
```

---

## Task 1: Store-Konflikt-API

**Files:**
- Modify: `src/store/store.ts`
- Test: `test/storeConflict.test.ts`

**Interfaces:**
- Consumes: vorhandene `store`-Interna (`getRaw`, `exists`, `decodeFile`, `encodeFile`, `keys`, `db`, `chunkSize`), `pathId`, `NoteDoc`/`ChunkDoc`/`FileMeta`.
- Produces (neue Methoden auf `VaultStore`):
  - `readNoteRev(id: string, rev: string): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null>`
  - `interface ConflictVersion { rev: string; bytes: Uint8Array; meta: FileMeta }`
  - `getConflict(id: string): Promise<{ id: string; path: string; isBinary: boolean; local: ConflictVersion; remotes: ConflictVersion[] } | null>`
  - `resolveConflict(id: string, path: string, mergedBytes: Uint8Array, meta: FileMeta, pruneRevs: string[]): Promise<void>`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/storeConflict.test.ts`:
```ts
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
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/storeConflict.test.ts`
Expected: FAIL (Methoden fehlen).

- [ ] **Step 3: Methoden in `src/store/store.ts` ergänzen**

Füge diese Methoden in die `VaultStore`-Klasse ein (nach `readNote`, vor den `private`-Helfern). Ergänze am Dateikopf keinen neuen Import — `decodeFile`/`encodeFile`/`pathId`/Typen sind bereits importiert:

```ts
  async readNoteRev(
    id: string,
    rev: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null> {
    let note: NoteDoc;
    try {
      note = await this.db.get<NoteDoc>(id, { rev });
    } catch {
      return null;
    }
    return decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
  }

  async getConflict(id: string): Promise<{
    id: string;
    path: string;
    isBinary: boolean;
    local: { rev: string; bytes: Uint8Array; meta: FileMeta };
    remotes: { rev: string; bytes: Uint8Array; meta: FileMeta }[];
  } | null> {
    let winning: NoteDoc & { _rev: string; _conflicts?: string[] };
    try {
      winning = await this.db.get<NoteDoc>(id, { conflicts: true });
    } catch {
      return null;
    }
    if (!winning._conflicts || winning._conflicts.length === 0) return null;
    const local = await decodeFile(this.keys, winning, (cid) => this.db.get<ChunkDoc>(cid));
    const remotes: { rev: string; bytes: Uint8Array; meta: FileMeta }[] = [];
    for (const rev of winning._conflicts) {
      const version = await this.readNoteRev(id, rev);
      if (version) remotes.push({ rev, bytes: version.bytes, meta: version.meta });
    }
    return {
      id,
      path: local.path,
      isBinary: local.meta.isBinary,
      local: { rev: winning._rev, bytes: local.bytes, meta: local.meta },
      remotes,
    };
  }

  async resolveConflict(
    id: string,
    path: string,
    mergedBytes: Uint8Array,
    meta: FileMeta,
    pruneRevs: string[],
  ): Promise<void> {
    const winning = await this.getRaw<NoteDoc>(id);
    const { note, chunks } = await encodeFile(this.keys, path, mergedBytes, meta, this.chunkSize);
    for (const chunk of chunks) {
      if (!(await this.exists(chunk._id))) {
        try {
          await this.db.put(chunk);
        } catch (e) {
          const status = (e as { status?: number }).status;
          const name = (e as { name?: string }).name;
          if (status !== 409 && name !== "conflict") throw e;
        }
      }
    }
    if (winning) note._rev = winning._rev;
    await this.db.put(note);
    for (const rev of pruneRevs) {
      await this.db.remove(id, rev);
    }
  }
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/storeConflict.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/storeConflict.test.ts
git commit -m "feat(store): Konflikt-API (getConflict/readNoteRev/resolveConflict mit Revisions-Pruning)"
```

---

## Task 2: Diff-/Merge-Modell

**Files:**
- Modify: `package.json` (Dependency `diff`)
- Create: `src/conflicts/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Consumes: `diff` (jsdiff, `diffLines`).
- Produces:
  - `type Hunk = { kind: "equal"; lines: string[] } | { kind: "change"; local: string[]; remote: string[] }`
  - `computeHunks(localText: string, remoteText: string): Hunk[]`
  - `mergedText(hunks: Hunk[], decisions: Record<number, "local" | "remote">): string` (Index = laufende Nummer des change-Hunks; Default „local")
  - `wholeSide(hunks: Hunk[], side: "local" | "remote"): string`

- [ ] **Step 1: `diff` installieren**

Run:
```bash
cd "23 obsidian-sync/vaultbridge"
npm install --save diff
npm install --save-dev @types/diff
```

- [ ] **Step 2: Fehlschlagenden Test schreiben**

`test/diff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeHunks, mergedText, wholeSide } from "../src/conflicts/diff";

const local = "a\nb\nc\nd";
const remote = "a\nB2\nc\nD2";

describe("diff-Modell", () => {
  it("erzeugt equal- und change-Hunks", () => {
    const hunks = computeHunks(local, remote);
    // erwartet: equal[a], change(b/B2), equal[c], change(d/D2)
    const changes = hunks.filter((h) => h.kind === "change");
    expect(changes.length).toBe(2);
    expect(hunks.some((h) => h.kind === "equal")).toBe(true);
  });

  it("mergedText nimmt per Entscheidung lokal/remote (Default lokal)", () => {
    const hunks = computeHunks(local, remote);
    expect(mergedText(hunks, {})).toBe(local); // alle Default lokal
    expect(mergedText(hunks, { 0: "remote", 1: "remote" })).toBe(remote);
    expect(mergedText(hunks, { 0: "remote", 1: "local" })).toBe("a\nB2\nc\nd");
  });

  it("wholeSide liefert komplett eine Seite", () => {
    const hunks = computeHunks(local, remote);
    expect(wholeSide(hunks, "local")).toBe(local);
    expect(wholeSide(hunks, "remote")).toBe(remote);
  });

  it("reine Ergänzung wird als change-Hunk erfasst", () => {
    const hunks = computeHunks("a\nc", "a\nb\nc");
    expect(mergedText(hunks, { 0: "remote" })).toBe("a\nb\nc");
    expect(mergedText(hunks, { 0: "local" })).toBe("a\nc");
  });
});
```

- [ ] **Step 3: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/diff.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 4: `src/conflicts/diff.ts` implementieren**

```ts
import { diffLines } from "diff";

export type Hunk =
  | { kind: "equal"; lines: string[] }
  | { kind: "change"; local: string[]; remote: string[] };

function toLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // Artefakt eines abschließenden \n
  return lines;
}

export function computeHunks(localText: string, remoteText: string): Hunk[] {
  const parts = diffLines(localText, remoteText);
  const hunks: Hunk[] = [];
  let pendLocal: string[] = [];
  let pendRemote: string[] = [];
  const flush = () => {
    if (pendLocal.length || pendRemote.length) {
      hunks.push({ kind: "change", local: pendLocal, remote: pendRemote });
      pendLocal = [];
      pendRemote = [];
    }
  };
  for (const part of parts) {
    const lines = toLines(part.value);
    if (part.added) {
      pendRemote.push(...lines);
    } else if (part.removed) {
      pendLocal.push(...lines);
    } else {
      flush();
      if (lines.length) hunks.push({ kind: "equal", lines });
    }
  }
  flush();
  return hunks;
}

export function mergedText(
  hunks: Hunk[],
  decisions: Record<number, "local" | "remote">,
): string {
  const out: string[] = [];
  let changeIdx = 0;
  for (const h of hunks) {
    if (h.kind === "equal") {
      out.push(...h.lines);
    } else {
      const choice = decisions[changeIdx] ?? "local";
      out.push(...(choice === "local" ? h.local : h.remote));
      changeIdx++;
    }
  }
  return out.join("\n");
}

export function wholeSide(hunks: Hunk[], side: "local" | "remote"): string {
  const out: string[] = [];
  for (const h of hunks) {
    if (h.kind === "equal") out.push(...h.lines);
    else out.push(...(side === "local" ? h.local : h.remote));
  }
  return out.join("\n");
}
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/diff.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/conflicts/diff.ts test/diff.test.ts
git commit -m "feat(conflicts): reines Zeilen-Diff-/Merge-Modell (Hunks, Übernahme lokal/remote)"
```

---

## Task 3: ConflictSession (Auflöse-Logik)

**Files:**
- Create: `src/conflicts/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `computeHunks`/`mergedText`/`wholeSide`/`Hunk` (`conflicts/diff`); `utf8` (`crypto/encoding`).
- Produces:
  - `interface ConflictInput { id: string; path: string; isBinary: boolean; local: { rev: string; bytes: Uint8Array }; remote: { rev: string; bytes: Uint8Array } }`
  - `class ConflictSession` mit:
    - `constructor(input: ConflictInput)`
    - `hunks: Hunk[]` (leer bei Binär)
    - `setDecision(changeIndex: number, side: "local" | "remote"): void`
    - `takeWhole(side: "local" | "remote"): void`
    - `resultBytes(): Uint8Array` (bei Text: gemergter Text; bei Binär: gewählte Seite — Default lokal)
    - `pruneRev(): string` (die Revision der bearbeiteten Remote-Version)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ConflictSession } from "../src/conflicts/session";
import { utf8 } from "../src/crypto/encoding";

function input(over: Partial<any> = {}) {
  return {
    id: "n:1",
    path: "K.md",
    isBinary: false,
    local: { rev: "2-a", bytes: utf8.encode("a\nb\nc") },
    remote: { rev: "2-b", bytes: utf8.encode("a\nB2\nc") },
    ...over,
  };
}

describe("ConflictSession", () => {
  it("Default-Ergebnis = lokal", () => {
    const s = new ConflictSession(input());
    expect(utf8.decode(s.resultBytes())).toBe("a\nb\nc");
    expect(s.pruneRev()).toBe("2-b");
  });

  it("setDecision übernimmt einzelnen Hunk von remote", () => {
    const s = new ConflictSession(input());
    s.setDecision(0, "remote");
    expect(utf8.decode(s.resultBytes())).toBe("a\nB2\nc");
  });

  it("takeWhole remote nimmt komplette Remote-Seite", () => {
    const s = new ConflictSession(input());
    s.takeWhole("remote");
    expect(utf8.decode(s.resultBytes())).toBe("a\nB2\nc");
  });

  it("Binär: keine Hunks, Ergebnis = gewählte Seite", () => {
    const s = new ConflictSession(
      input({ isBinary: true, local: { rev: "2-a", bytes: new Uint8Array([1, 2]) }, remote: { rev: "2-b", bytes: new Uint8Array([9]) } }),
    );
    expect(s.hunks.length).toBe(0);
    expect([...s.resultBytes()]).toEqual([1, 2]); // Default lokal
    s.takeWhole("remote");
    expect([...s.resultBytes()]).toEqual([9]);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: `src/conflicts/session.ts` implementieren**

```ts
import { computeHunks, mergedText, wholeSide, Hunk } from "./diff";
import { utf8 } from "../crypto/encoding";

export interface ConflictInput {
  id: string;
  path: string;
  isBinary: boolean;
  local: { rev: string; bytes: Uint8Array };
  remote: { rev: string; bytes: Uint8Array };
}

export class ConflictSession {
  readonly hunks: Hunk[];
  private decisions: Record<number, "local" | "remote"> = {};
  private binaryChoice: "local" | "remote" = "local";

  constructor(private readonly input: ConflictInput) {
    this.hunks = input.isBinary
      ? []
      : computeHunks(utf8.decode(input.local.bytes), utf8.decode(input.remote.bytes));
  }

  setDecision(changeIndex: number, side: "local" | "remote"): void {
    this.decisions[changeIndex] = side;
  }

  takeWhole(side: "local" | "remote"): void {
    this.binaryChoice = side;
    let changeIdx = 0;
    for (const h of this.hunks) {
      if (h.kind === "change") this.decisions[changeIdx++] = side;
    }
  }

  resultBytes(): Uint8Array {
    if (this.input.isBinary) {
      return this.binaryChoice === "local" ? this.input.local.bytes : this.input.remote.bytes;
    }
    return utf8.encode(mergedText(this.hunks, this.decisions));
  }

  pruneRev(): string {
    return this.input.remote.rev;
  }
}
```

(`wholeSide` bleibt für die Vorschau der reinen Seiten in der UI exportiert; hier wird `mergedText` mit vollständigen Entscheidungen genutzt, damit `takeWhole` und einzelne `setDecision` denselben Pfad teilen.)

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/conflicts/session.ts test/session.test.ts
git commit -m "feat(conflicts): ConflictSession (Entscheidungen -> gemergte Bytes, Text + Binär)"
```

---

## Task 4: Konflikt-UI (Liste + Resolver) + Verdrahtung

**Files:**
- Create: `src/ui/ConflictListView.ts`, `src/ui/ConflictResolverModal.ts`
- Modify: `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: `VaultStore.listConflicts/getConflict/resolveConflict`, `ConflictSession`, Obsidian `ItemView`/`Modal`/`Notice`.
- Produces: eine Konflikt-Ansicht (ItemView) mit Liste + Öffnen des Resolvers; ein Resolver-Modal mit zweispaltigem Diff + Buttons; `main.ts` registriert View, Befehl „Vaultbridge: Konflikte anzeigen" und einen Statusbar-Badge. Manuell verifiziert.

- [ ] **Step 1: Resolver-Modal implementieren**

`src/ui/ConflictResolverModal.ts`:
```ts
import { App, Modal, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictSession } from "../conflicts/session";

export class ConflictResolverModal extends Modal {
  constructor(
    app: App,
    private readonly store: VaultStore,
    private readonly noteId: string,
    private readonly onResolved: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const conflict = await this.store.getConflict(this.noteId);
    if (!conflict || conflict.remotes.length === 0) {
      contentEl.setText("Kein Konflikt mehr vorhanden.");
      this.onResolved();
      return;
    }
    contentEl.createEl("h3", { text: `Konflikt: ${conflict.path}` });
    const session = new ConflictSession({
      id: conflict.id,
      path: conflict.path,
      isBinary: conflict.isBinary,
      local: { rev: conflict.local.rev, bytes: conflict.local.bytes },
      remote: { rev: conflict.remotes[0].rev, bytes: conflict.remotes[0].bytes },
    });

    if (conflict.isBinary) {
      this.renderBinary(contentEl, session, conflict);
    } else {
      this.renderDiff(contentEl, session);
    }

    const footer = contentEl.createDiv({ cls: "vb-conflict-footer" });
    footer.createEl("button", { text: "Ganz lokal" }).onclick = () => { session.takeWhole("local"); };
    footer.createEl("button", { text: "Ganz remote" }).onclick = () => { session.takeWhole("remote"); };
    const save = footer.createEl("button", { text: "Zusammenführen & speichern" });
    save.addClass("mod-cta");
    save.onclick = async () => {
      await this.store.resolveConflict(
        conflict.id,
        conflict.path,
        session.resultBytes(),
        conflict.local.meta,
        [session.pruneRev()],
      );
      new Notice(`Konflikt gelöst: ${conflict.path}`);
      this.onResolved();
      this.close();
    };
  }

  private renderDiff(root: HTMLElement, session: ConflictSession): void {
    const table = root.createDiv({ cls: "vb-diff" });
    let changeIdx = 0;
    for (const hunk of session.hunks) {
      if (hunk.kind === "equal") {
        const row = table.createDiv({ cls: "vb-diff-row vb-equal" });
        row.createDiv({ cls: "vb-col", text: hunk.lines.join("\n") });
        row.createDiv({ cls: "vb-col", text: hunk.lines.join("\n") });
      } else {
        const idx = changeIdx++;
        const row = table.createDiv({ cls: "vb-diff-row vb-change" });
        const left = row.createDiv({ cls: "vb-col vb-local", text: hunk.local.join("\n") || "(leer)" });
        const right = row.createDiv({ cls: "vb-col vb-remote", text: hunk.remote.join("\n") || "(leer)" });
        const mark = (chosen: "local" | "remote") => {
          left.toggleClass("vb-chosen", chosen === "local");
          right.toggleClass("vb-chosen", chosen === "remote");
        };
        mark("local");
        left.createEl("button", { text: "← übernehmen" }).onclick = () => { session.setDecision(idx, "local"); mark("local"); };
        right.createEl("button", { text: "übernehmen →" }).onclick = () => { session.setDecision(idx, "remote"); mark("remote"); };
      }
    }
  }

  private renderBinary(
    root: HTMLElement,
    session: ConflictSession,
    conflict: { local: { bytes: Uint8Array; meta: { size: number } }; remotes: { bytes: Uint8Array; meta: { size: number } }[] },
  ): void {
    root.createEl("p", { text: "Binärdatei — kein Textvergleich möglich. Version wählen:" });
    const cards = root.createDiv({ cls: "vb-binary" });
    const local = cards.createDiv({ cls: "vb-card vb-chosen" });
    local.createEl("b", { text: "Lokal" });
    local.createEl("div", { text: `${conflict.local.bytes.length} Bytes` });
    const remote = cards.createDiv({ cls: "vb-card" });
    remote.createEl("b", { text: "Remote" });
    remote.createEl("div", { text: `${conflict.remotes[0].bytes.length} Bytes` });
    local.onclick = () => { session.takeWhole("local"); local.addClass("vb-chosen"); remote.removeClass("vb-chosen"); };
    remote.onclick = () => { session.takeWhole("remote"); remote.addClass("vb-chosen"); local.removeClass("vb-chosen"); };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Konflikt-Listen-View implementieren**

`src/ui/ConflictListView.ts`:
```ts
import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictResolverModal } from "./ConflictResolverModal";

export const VIEW_TYPE_CONFLICTS = "vaultbridge-conflicts";

export class ConflictListView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly getStore: () => VaultStore | null) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CONFLICTS; }
  getDisplayText(): string { return "Vaultbridge-Konflikte"; }
  getIcon(): string { return "git-merge"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "Konflikte" });
    const store = this.getStore();
    if (!store) {
      root.createEl("p", { text: "Nicht verbunden." });
      return;
    }
    const ids = await store.listConflicts();
    if (ids.length === 0) {
      root.createEl("p", { text: "Keine Konflikte 🎉" });
      return;
    }
    const list = root.createEl("ul");
    for (const id of ids) {
      const conflict = await store.getConflict(id);
      if (!conflict) continue;
      const li = list.createEl("li");
      const btn = li.createEl("button", { text: conflict.path });
      btn.onclick = () => {
        new ConflictResolverModal(this.app, store, id, () => void this.render()).open();
      };
    }
  }
}
```

- [ ] **Step 3: `main.ts` erweitern**

Ergänze in `src/main.ts`:
- Import: `import { ConflictListView, VIEW_TYPE_CONFLICTS } from "./ui/ConflictListView";`
- In `onload()` (nach `addSettingTab`):
```ts
    this.registerView(
      VIEW_TYPE_CONFLICTS,
      (leaf) => new ConflictListView(leaf, () => this.store),
    );
    this.addCommand({
      id: "vaultbridge-show-conflicts",
      name: "Vaultbridge: Konflikte anzeigen",
      callback: () => this.openConflictView(),
    });
```
- Neues Feld `private store: VaultStore | null = null;` (Import `VaultStore` aus `./store/store`), und in `connect()` beim Erzeugen des Stores `this.store = store;` setzen; in `disconnect()` `this.store = null;`.
- Neue Methode:
```ts
  async openConflictView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true });
    }
    workspace.revealLeaf(leaf);
  }
```

- [ ] **Step 4: `styles.css` ergänzen**

```css
.vb-diff-row { display: flex; gap: 8px; border-bottom: 1px solid var(--background-modifier-border); }
.vb-col { flex: 1; white-space: pre-wrap; padding: 4px; font-family: var(--font-monospace); }
.vb-change .vb-local { background: rgba(255,0,0,0.08); }
.vb-change .vb-remote { background: rgba(0,128,0,0.08); }
.vb-col.vb-chosen { outline: 2px solid var(--interactive-accent); }
.vb-conflict-footer { display: flex; gap: 8px; margin-top: 12px; }
.vb-binary { display: flex; gap: 12px; }
.vb-card { border: 1px solid var(--background-modifier-border); padding: 12px; cursor: pointer; border-radius: 6px; }
.vb-card.vb-chosen { outline: 2px solid var(--interactive-accent); }
```

- [ ] **Step 5: Build + volle Suite**

Run: `npm run build && npm test`
Expected: `tsc` + esbuild ohne Fehler; `main.js` erzeugt (inkl. `diff`); alle Tests grün.

- [ ] **Step 6: Manuelle Verifikation (pending human)**

Konflikt provozieren: dieselbe Notiz auf zwei verbundenen Instanzen ohne zwischenzeitlichen Sync unterschiedlich ändern → „Vaultbridge: Konflikte anzeigen" → Datei öffnen → zweispaltiger Diff, Hunk-Übernahme + „Zusammenführen & speichern" → Konflikt verschwindet, gemergte Datei im Vault. Report dokumentiert die Schritte als „pending human verification".

- [ ] **Step 7: Commit**

```bash
git add src/ui/ConflictListView.ts src/ui/ConflictResolverModal.ts src/main.ts styles.css
git commit -m "feat(ui): Konflikt-Liste + zweispaltiger Diff-Resolver (Hunk-/Ganzdatei-Übernahme, Binär-Karten)"
```

---

## Task 5: Integrationstest — Konflikt erkennen, lösen, konvergieren

**Files:**
- Create: `test/conflictIntegration.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `ConflictSession`, `deriveKeys`, `createTestPouch`, `utf8`, `FileMeta`.

- [ ] **Step 1: Integrationstest schreiben**

`test/conflictIntegration.test.ts`:
```ts
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
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run test/conflictIntegration.test.ts`
Expected: PASS (1 Test).

- [ ] **Step 3: Volle Suite + Build**

Run: `npm test && npm run build`
Expected: alle Tests PASS, `main.js` erzeugt.

- [ ] **Step 4: Commit**

```bash
git add test/conflictIntegration.test.ts
git commit -m "test: Integrationstest — Konflikt erkennen, per Hunk mischen, konfliktfrei konvergieren"
```

---

## Meilenstein-3-Abschluss

Danach existiert die vollständige Konflikt-Diff-UI: Store-Konflikt-API, ein headless getestetes Diff-/Merge-Modell und eine `ConflictSession`, eine Konflikt-Liste und ein zweispaltiger Resolver (Hunk-/Ganzdatei-Übernahme, Binär-Karten), plus ein Integrationstest, der Erkennen → Mischen → konfliktfreies Konvergieren nachweist. **Manuelle Verifikation offen:** der Resolver in Obsidian zwischen zwei verbundenen Instanzen.

**Noch nicht enthalten (spätere Meilensteine):** Dateisteuerung/Regeln, Mobile-Sync-Modi, QR-Onboarding, Setup-Generator (M4); Datei-Verlauf (M5); Passphrase-Rotation (M6); Release/Community-Einreichung (M7). Drei-Wege-Merge bei >2 Konfliktversionen wird iterativ (eine Remote-Version pro Durchgang) gelöst; ein echter 3-Spalten-Merge ist optional später.
