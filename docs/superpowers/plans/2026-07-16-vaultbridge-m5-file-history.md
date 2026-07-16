# Vaultbridge — Meilenstein 5: Datei-Versionsverlauf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Frühere Versionen einer Datei über die CouchDB-Revisionen ansehen (mit Diff gegen aktuell) und wiederherstellen.

**Architecture:** Auf M1–M4. Der Store bekommt zwei Methoden auf Basis des bestehenden `readNoteRev` (M3): `listRevisions(id)` (verfügbare Revisionen entschlüsselt auflisten via PouchDBs `revs_info`) und `restoreRevision(id, rev)` (eine alte Version als neue Gewinner-Revision schreiben, via `putFile`). Eine Verlauf-UI (`HistoryModal`) zeigt die Zeitleiste, einen read-only Zweispalt-Diff (alt ↔ aktuell, mit dem M3-Diff-Modell) und einen Wiederherstellen-Button.

**Tech Stack:** TypeScript, esbuild, Vitest, PouchDB, `diff`, Obsidian API.

## Global Constraints

- Baut auf bestehenden Signaturen (nicht ändern): `VaultStore` (`putFile/getFile/readNote/readNoteRev/getConflict/...`), `computeHunks`/`mergedText` (`conflicts/diff`), `pathId`/`contentHash`.
- `listRevisions`/`restoreRevision` sind headless testbar (In-Memory-PouchDB); die UI ist manuell zu verifizieren.
- Verlauf-Tiefe hängt von CouchDBs `revs_limit`/Compaction ab — in der UI/Doku transparent machen.
- Nur Web-APIs + Obsidian-API + PouchDB + `diff` in `src/`. Deutsche UI-Strings.
- TS 5.9 `Uint8Array`/`BufferSource`: bei WebCrypto/Binary-APIs den `asBuffer`/`slice().buffer`-Ansatz wie bisher.
- TDD, häufige Commits, DRY, YAGNI. Arbeitsverzeichnis: `23 obsidian-sync/vaultbridge/`.

---

## Dateistruktur (Meilenstein 5)

```
src/store/store.ts     # erweitert: listRevisions, restoreRevision
src/ui/HistoryModal.ts # Verlauf-Zeitleiste + read-only Diff + Wiederherstellen
src/main.ts            # erweitert: Befehl "Datei-Verlauf anzeigen"
test/history.test.ts   test/historyIntegration.test.ts
```

---

## Task 1: Store — listRevisions + restoreRevision

**Files:** Modify `src/store/store.ts`; Test `test/history.test.ts`

**Interfaces:**
- Consumes: vorhandene `readNoteRev`, `putFile`, `getRaw`, `db`, `keys`; `NoteDoc`.
- Produces:
  - `interface FileRevision { rev: string; bytes: Uint8Array; meta: FileMeta }`
  - `listRevisions(id: string): Promise<FileRevision[]>` (verfügbare Revisionen, **neueste zuerst**; Index 0 = aktuelle Version)
  - `restoreRevision(id: string, rev: string): Promise<void>` (schreibt den Inhalt dieser Revision als neue Gewinner-Revision)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/history.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(9);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

async function storeWith3() {
  const keys = await deriveKeys("pw", salt, 50000);
  const store = new VaultStore(createTestPouch(), keys, 4);
  await store.putFile("x.md", utf8.encode("v1"), meta);
  await store.putFile("x.md", utf8.encode("v2"), meta);
  await store.putFile("x.md", utf8.encode("v3"), meta);
  const id = await pathId(keys.idKey, "x.md");
  return { store, id };
}

describe("Datei-Verlauf", () => {
  it("listRevisions liefert verfügbare Revisionen, neueste zuerst", async () => {
    const { store, id } = await storeWith3();
    const revs = await store.listRevisions(id);
    expect(revs.length).toBeGreaterThanOrEqual(3);
    expect(utf8.decode(revs[0].bytes)).toBe("v3"); // aktuell zuerst
    expect(utf8.decode(revs[revs.length - 1].bytes)).toBe("v1"); // älteste zuletzt
  });

  it("restoreRevision stellt einen alten Inhalt als neue Version her", async () => {
    const { store, id } = await storeWith3();
    const revs = await store.listRevisions(id);
    const oldest = revs[revs.length - 1];
    expect(utf8.decode(oldest.bytes)).toBe("v1");
    await store.restoreRevision(id, oldest.rev);
    expect(utf8.decode((await store.getFile("x.md"))!.bytes)).toBe("v1");
    // Wiederherstellung erzeugt eine neue Revision (kein Konflikt)
    expect((await store.listConflicts()).length).toBe(0);
    expect((await store.listRevisions(id)).length).toBeGreaterThanOrEqual(4);
  });

  it("listRevisions gibt leer bei unbekannter id", async () => {
    const { store } = await storeWith3();
    expect(await store.listRevisions("n:deadbeef")).toEqual([]);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/history.test.ts`

- [ ] **Step 3: Methoden in `src/store/store.ts` ergänzen** (nach `readNoteRev`)

```ts
  async listRevisions(id: string): Promise<{ rev: string; bytes: Uint8Array; meta: FileMeta }[]> {
    let revsInfo: { rev: string; status: string }[];
    try {
      const doc = await this.db.get<NoteDoc>(id, { revs_info: true });
      revsInfo = ((doc as unknown as { _revs_info?: { rev: string; status: string }[] })._revs_info) ?? [];
    } catch {
      return [];
    }
    const out: { rev: string; bytes: Uint8Array; meta: FileMeta }[] = [];
    for (const entry of revsInfo) {
      if (entry.status !== "available") continue; // compaktierte/fehlende Revisionen überspringen
      const version = await this.readNoteRev(id, entry.rev);
      if (version) out.push({ rev: entry.rev, bytes: version.bytes, meta: version.meta });
    }
    return out; // PouchDB liefert revs_info von neu nach alt
  }

  async restoreRevision(id: string, rev: string): Promise<void> {
    const version = await this.readNoteRev(id, rev);
    if (!version) throw new Error("Revision nicht verfügbar (evtl. bereinigt).");
    await this.putFile(version.path, version.bytes, version.meta);
  }
```

- [ ] **Step 4: Test ausführen → PASS (3 Tests)** — Run: `npx vitest run test/history.test.ts`

- [ ] **Step 5: Commit** — `git add src/store/store.ts test/history.test.ts && git commit -m "feat(store): Datei-Verlauf (listRevisions/restoreRevision über CouchDB-Revisionen)"`

---

## Task 2: Verlauf-UI (HistoryModal) + Verdrahtung

**Files:** Create `src/ui/HistoryModal.ts`; Modify `src/main.ts`, `styles.css`. Manuell verifiziert.

**Interfaces:** Nutzt `VaultStore.listRevisions/restoreRevision`, `pathId` (aus `crypto/crypto`), `computeHunks` (`conflicts/diff`), Obsidian `Modal`/`Notice`.

- [ ] **Step 1: `HistoryModal.ts` implementieren**

`src/ui/HistoryModal.ts`:
```ts
import { App, Modal, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { computeHunks } from "../conflicts/diff";
import { utf8 } from "../crypto/encoding";

export class HistoryModal extends Modal {
  constructor(
    private readonly store: VaultStore,
    private readonly noteId: string,
    private readonly displayPath: string,
    private readonly onRestored: () => void,
    app: App,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Verlauf: ${this.displayPath}` });
    const revs = await this.store.listRevisions(this.noteId);
    if (revs.length <= 1) {
      contentEl.createEl("p", { text: "Keine früheren Versionen vorhanden." });
      return;
    }
    const current = revs[0].bytes;
    const list = contentEl.createDiv({ cls: "vb-history-list" });
    const detail = contentEl.createDiv({ cls: "vb-history-detail" });

    revs.forEach((rev, i) => {
      const item = list.createEl("button", {
        text: i === 0 ? "Aktuelle Version" : `Version ${revs.length - i} (${rev.bytes.length} B)`,
      });
      if (i === 0) item.addClass("mod-cta");
      item.onclick = () => this.showRevision(detail, current, rev, i === 0);
    });
    this.showRevision(detail, current, revs[1], false); // vorherige Version vorwählen
  }

  private showRevision(
    root: HTMLElement,
    current: Uint8Array,
    rev: { rev: string; bytes: Uint8Array },
    isCurrent: boolean,
  ): void {
    root.empty();
    if (isCurrent) {
      root.createEl("p", { text: "Das ist die aktuelle Version." });
      return;
    }
    // read-only Zweispalt-Diff: alt (links) vs. aktuell (rechts)
    const hunks = computeHunks(utf8.decode(rev.bytes), utf8.decode(current));
    const table = root.createDiv({ cls: "vb-diff" });
    for (const h of hunks) {
      const row = table.createDiv({ cls: "vb-diff-row" + (h.kind === "change" ? " vb-change" : "") });
      if (h.kind === "equal") {
        row.createDiv({ cls: "vb-col", text: h.lines.join("") });
        row.createDiv({ cls: "vb-col", text: h.lines.join("") });
      } else {
        row.createDiv({ cls: "vb-col vb-local", text: h.local.join("") || "(leer)" });
        row.createDiv({ cls: "vb-col vb-remote", text: h.remote.join("") || "(leer)" });
      }
    }
    const restore = root.createEl("button", { text: "Diese Version wiederherstellen" });
    restore.addClass("mod-cta");
    restore.onclick = async () => {
      try {
        await this.store.restoreRevision(this.noteId, rev.rev);
        new Notice(`Version von ${this.displayPath} wiederhergestellt.`);
        this.onRestored();
        this.close();
      } catch (e) {
        new Notice(`Vaultbridge: Wiederherstellen fehlgeschlagen: ${String(e)}`);
      }
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: `main.ts` verdrahten** — Befehl für die aktive Datei:
```ts
    this.addCommand({
      id: "vaultbridge-file-history",
      name: "Vaultbridge: Datei-Verlauf anzeigen",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.store) return false;
        if (!checking) void this.openHistory(file.path);
        return true;
      },
    });
```
und die Methode (importiere `HistoryModal`, `pathId` aus `./crypto/crypto`):
```ts
  private async openHistory(path: string): Promise<void> {
    if (!this.store) { new Notice("Vaultbridge: nicht verbunden."); return; }
    const id = await pathId(this.keysForHistory!.idKey, path);
    new HistoryModal(this.store, id, path, () => {}, this.app).open();
  }
```
Hinweis: `pathId` braucht den `idKey`. Der wird beim `connect()` aus `deriveKeys` gewonnen — speichere die abgeleiteten `keys` in einem Feld `private keysForHistory: VaultKeys | null = null;` beim Verbinden (in `connect()` `this.keysForHistory = keys;`, in `disconnect()` `this.keysForHistory = null;`). Importiere `VaultKeys` aus `./crypto/crypto`.

- [ ] **Step 3: `styles.css`** — ergänze:
```css
.vb-history-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.vb-history-detail { border-top: 1px solid var(--background-modifier-border); padding-top: 8px; }
```
(Die `.vb-diff*`-Styles existieren bereits aus M3.)

- [ ] **Step 4: Build + volle Suite** — `npm run build && npm test`.

- [ ] **Step 5: Manuelle Verifikation (pending human)** — eine Notiz mehrfach ändern (mit Sync), „Datei-Verlauf anzeigen" → Zeitleiste, Diff gegen aktuell, „wiederherstellen" → Datei kehrt zurück, neue Version entsteht.

- [ ] **Step 6: Commit** — `git add src/ui/HistoryModal.ts src/main.ts styles.css && git commit -m "feat(ui): Datei-Verlauf-Modal (Zeitleiste + read-only Diff + Wiederherstellen)"`

---

## Task 3: Integrationstest — Verlauf + Wiederherstellung

**Files:** Create `test/historyIntegration.test.ts`

- [ ] **Step 1: Integrationstest schreiben**

`test/historyIntegration.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(21);
const meta: FileMeta = { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false };

describe("Integration: Verlauf + Wiederherstellung", () => {
  it("mehrere Bearbeitungen ergeben eine Historie; Wiederherstellen setzt den Inhalt zurück und bewahrt die Historie", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const store = new VaultStore(createTestPouch(), keys, 1024);
    await store.putFile("Tag.md", utf8.encode("Montag"), meta);
    await store.putFile("Tag.md", utf8.encode("Dienstag"), meta);
    await store.putFile("Tag.md", utf8.encode("Mittwoch"), meta);
    const id = await pathId(keys.idKey, "Tag.md");

    const before = await store.listRevisions(id);
    expect(before.map((r) => utf8.decode(r.bytes))).toEqual(["Mittwoch", "Dienstag", "Montag"]);

    // "Montag" (älteste) wiederherstellen
    await store.restoreRevision(id, before[before.length - 1].rev);
    expect(utf8.decode((await store.getFile("Tag.md"))!.bytes)).toBe("Montag");

    const after = await store.listRevisions(id);
    expect(utf8.decode(after[0].bytes)).toBe("Montag"); // neue aktuelle Version
    expect(after.length).toBe(before.length + 1); // Historie um eine Version gewachsen
    // frühere Versionen bleiben abrufbar
    expect(after.map((r) => utf8.decode(r.bytes))).toContain("Mittwoch");
  });
});
```

- [ ] **Step 2: Test ausführen → PASS** — Run: `npx vitest run test/historyIntegration.test.ts`

- [ ] **Step 3: Volle Suite + Build** — `npm test && npm run build`.

- [ ] **Step 4: Commit** — `git add test/historyIntegration.test.ts && git commit -m "test: Integrationstest — Datei-Verlauf + Wiederherstellung"`

---

## Meilenstein-5-Abschluss

Danach: Datei-Versionsverlauf über CouchDB-Revisionen — auflisten, gegen die aktuelle Version diffen, wiederherstellen; die Store-Logik headless getestet, die UI manuell zu verifizieren.

**Manuelle Verifikation offen:** Verlauf-Modal in Obsidian.

**Noch nicht enthalten / bekannte Grenzen:** Verlauf-Tiefe = CouchDBs `revs_limit`/Compaction; versteckte Dateien tragen `mtime/ctime=0` (aus M4), daher zeigt ihr Verlauf keine echten Zeitstempel — bei Bedarf später `adapter.stat` nutzen. M6 Passphrase-Rotation; M7 Release/Community-Einreichung.
