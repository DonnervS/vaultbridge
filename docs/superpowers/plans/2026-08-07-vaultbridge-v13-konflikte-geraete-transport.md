# Vaultbridge v1.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein neu hinzugefügtes Gerät erzeugt keine Konflikte mehr, übrig gebliebene Konflikte werden automatisch und verlustfrei aufgelöst, die Vergleichsansicht nennt das Gerät jeder Seite, und die Anbindung lässt sich auf einen Transportweg umstellen, den Chromiums Local Network Access nicht blockiert.

**Architecture:** Die Ursache der Phantom-Konflikte ist eine Reihenfolge in `main.ts:connect()` — die Bridge lädt hoch, bevor die Replikation den lokalen Store gefüllt hat. Der Fix dreht die Reihenfolge um und sichert sie über ein persistentes Flag ab. Die neue Logik (Auflösungsplanung, URL-Prüfung, Gerätename, `fetch`-Adapter) liegt konsequent in reinen Modulen **ohne `obsidian`-Import**, damit sie unter vitest testbar ist; die Obsidian-Schicht ruft sie nur auf.

**Tech Stack:** TypeScript, esbuild, vitest, PouchDB 9 (`pouchdb-browser` im Plugin, `pouchdb-adapter-memory` im Test), Obsidian Plugin API ≥ 1.7.2, WebCrypto (AES-GCM/PBKDF2).

**Spec:** [`docs/superpowers/specs/2026-08-06-vaultbridge-konfliktvermeidung-geraete-transport-design.md`](../specs/2026-08-06-vaultbridge-konfliktvermeidung-geraete-transport-design.md)

## Global Constraints

- **Zielversion 1.3.0** — `manifest.json`, `package.json` und `versions.json` erst in Task 13 anfassen, alle drei gemeinsam.
- **UI-Sprache ist Deutsch.** Alle sichtbaren Texte, Meldungen und Einstellungsbeschriftungen auf Deutsch. Kommentare im Code ebenfalls Deutsch (Bestandskonvention).
- **`isDesktopOnly: false`** — keine Node-APIs (`fs`, `os`, `path`, `require`) im Plugin-Code. Plattformerkennung ausschließlich über `Platform` aus `obsidian`.
- **Kein `obsidian`-Import in Modulen, die Unit-Tests haben.** Die Tests laufen in `environment: "node"` ohne Obsidian-Stub; ein `import ... from "obsidian"` lässt die Testdatei sofort scheitern. Abhängigkeiten auf Obsidian-APIs werden als Parameter injiziert.
- **ESLint (`eslint-plugin-obsidianmd`) muss fehlerfrei bleiben:** kein `innerHTML`/`outerHTML`, DOM nur über `createEl`/`createDiv`/`createSpan`/`setText`, keine eigenen Überschriften-Elemente in Settings (stattdessen `new Setting(el).setName(...).setHeading()`), `app` nie global referenzieren. Prüfen mit `npm run lint`.
- **Keine neuen Laufzeit-Abhängigkeiten.** `package.json` `dependencies` bleibt unverändert.
- **Rückwärtskompatibilität:** Neue Felder in `FileMeta` und `VaultbridgeSettings` sind optional bzw. haben Defaults. Dokumente aus 1.2.x müssen ohne Migration lesbar bleiben.
- **Befehle:** `npm test` (vitest), `npm run lint` (ESLint), `npm run build` (tsc + esbuild + Bundle-Prüfung). Nach jeder Task müssen alle drei durchlaufen.
- **Commits auf Deutsch**, Conventional-Prefix (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`), Branch `feat/v1.3-konflikte-geraete-transport`.

## File Structure

**Neu**

| Datei | Verantwortung |
|---|---|
| `src/store/initialSync.ts` | Schlüssel für den Erst-Pull-Riegel; `uploadIfChanged` als einzige Stelle, die entscheidet, ob eine lokale Datei hochgeladen wird. Kein `obsidian`-Import. |
| `src/conflicts/autoResolve.ts` | Reine Planungslogik: aus Konfliktzweigen wird ein Auflösungsplan. Kein `obsidian`-Import, keine PouchDB-Abhängigkeit. |
| `src/setup/deviceName.ts` | Vorschlag für den Gerätenamen aus Plattform-Flags. Flags werden übergeben, nicht importiert. |
| `src/setup/couchUrl.ts` | Prüfung und Normalisierung der CouchDB-URL. Rein. |
| `src/store/obsidianFetch.ts` | `fetch`-kompatibler Adapter über eine injizierte `requestUrl`-artige Funktion. Kein `obsidian`-Import. |
| `test/initialPull.test.ts` | Regressionsnachweis: Reihenfolge Pull → Upload erzeugt keine Konflikte. |
| `test/autoResolve.test.ts` | Unit-Tests der Auflösungsregeln. |
| `test/deviceName.test.ts` | Unit-Tests der Namensbildung. |
| `test/couchUrl.test.ts` | Unit-Tests aller URL-Prüfregeln. |
| `test/obsidianFetch.test.ts` | Unit-Tests des `fetch`-Adapters mit gefälschter `requestUrl`. |
| `test/pruneConflict.test.ts` | Integrationstest für `pruneConflictRevs` gegen den Memory-Adapter. |

**Geändert**

| Datei | Änderung |
|---|---|
| `src/store/model.ts` | `FileMeta` um `device?` und `changedAt?` |
| `src/store/store.ts` | `ConflictVersion.deleted`, `readNoteRev` liefert `deleted`, neue Methode `pruneConflictRevs` |
| `src/vault/bridge.ts` | Erst-Upload-Gate, Lösch-Warteschlange, `device`/`changedAt` beim Schreiben, `uploadIfChanged` statt eigener Hash-Vergleich |
| `src/main.ts` | Erst-Pull vor Erst-Upload, `initialPullDone`, `autoResolveConflicts()`, `transport`, Gerätename-Vorbelegung |
| `src/ui/ConflictDiffView.ts` | Gerät + Zeitstempel in Kopfzeile, Spaltenköpfen, Binär-Karten |
| `src/ui/ConflictListView.ts` | Gerätezeile pro Eintrag |
| `src/ui/SettingsTab.ts` | Verbindungsart samt Hinweistext, Gerätename-Beschreibung, Selbsttest-Ausgabe für beide Wege |
| `src/ui/GeneratorModal.ts` | URL-Hilfe, Live-Prüfung, „Verbindung testen" |
| `src/setup/connection.ts` | Kommentar präzisieren (Default bleibt Browser-`fetch`) |
| `src/setup/selfTest.ts` | optionaler zweiter Transportweg |
| `styles.css` | Klassen für Gerätezeile und URL-Hinweise |
| `docs/server-setup.md`, `README.md` | Local-Network-Access-Abschnitt |
| `manifest.json`, `package.json`, `versions.json` | 1.3.0 |

---

## Stufe 1 — Erst-Pull vor Erst-Upload

### Task 1: `FileMeta` um Gerät und Änderungszeit erweitern

**Files:**
- Modify: `src/store/model.ts:1-7`
- Test: `test/transform.test.ts` (vorhanden, ergänzen)

**Interfaces:**
- Consumes: nichts
- Produces: `FileMeta.device?: string`, `FileMeta.changedAt?: number` — genutzt von Task 2, 6, 8

- [ ] **Step 1: Test schreiben, der den Roundtrip der neuen Felder prüft**

An `test/transform.test.ts` anhängen:

```ts
it("erhält device und changedAt über encode/decode hinweg", async () => {
  const keys = await deriveKeys("pw", new Uint8Array(16).fill(5), 50000);
  const meta: FileMeta = {
    mtime: 10, ctime: 5, size: 4, mime: "text/markdown", isBinary: false,
    device: "Mac-7f3", changedAt: 1770000000000,
  };
  const { note, chunks } = await encodeFile(keys, "N.md", utf8.encode("text"), meta, 1024);
  const byId = new Map(chunks.map((c) => [c._id, c]));
  const decoded = await decodeFile(keys, note, (id) => Promise.resolve(byId.get(id)!));
  expect(decoded.meta.device).toBe("Mac-7f3");
  expect(decoded.meta.changedAt).toBe(1770000000000);
});

it("liest Metadaten aus 1.2.x ohne device/changedAt weiterhin", async () => {
  const keys = await deriveKeys("pw", new Uint8Array(16).fill(5), 50000);
  const alt: FileMeta = { mtime: 10, ctime: 5, size: 4, mime: "", isBinary: false };
  const { note, chunks } = await encodeFile(keys, "A.md", utf8.encode("text"), alt, 1024);
  const byId = new Map(chunks.map((c) => [c._id, c]));
  const decoded = await decodeFile(keys, note, (id) => Promise.resolve(byId.get(id)!));
  expect(decoded.meta.device).toBeUndefined();
  expect(decoded.meta.changedAt).toBeUndefined();
});
```

Falls `deriveKeys`, `FileMeta` oder `utf8` in der Datei noch nicht importiert sind, Importe ergänzen:

```ts
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import type { FileMeta } from "../src/store/model";
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/transform.test.ts`
Expected: FAIL — TypeScript meldet, dass `device`/`changedAt` in `FileMeta` nicht existieren.

- [ ] **Step 3: `FileMeta` erweitern**

`src/store/model.ts`:

```ts
export interface FileMeta {
  mtime: number;
  ctime: number;
  size: number;
  mime: string;
  isBinary: boolean;
  // Anzeigename des Geräts, das diese Fassung geschrieben hat. Liegt in
  // meta_enc, ist also mitverschlüsselt — der Servereigentümer sieht keine
  // Gerätenamen. Optional: Dokumente aus 1.2.x haben das Feld nicht.
  device?: string;
  // Zeitpunkt des Schreibens nach der Uhr des schreibenden Geräts. Bewusst
  // NICHT mtime: reconcileHidden() schreibt für versteckte Dateien mtime 0,
  // dort gäbe es sonst nie einen Gewinner beim automatischen Auflösen.
  changedAt?: number;
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS (alle Testdateien)

- [ ] **Step 5: Commit**

```bash
git add src/store/model.ts test/transform.test.ts
git commit -m "feat: device und changedAt in FileMeta (verschlüsselt, optional)"
```

---

### Task 2: `initialSync.ts` — Upload-Entscheidung und Riegel-Schlüssel

**Files:**
- Create: `src/store/initialSync.ts`
- Create: `test/initialPull.test.ts`

**Interfaces:**
- Consumes: `VaultStore` (`src/store/store.ts`), `contentHash` (`src/vault/applyChange.ts`), `FileMeta` (Task 1)
- Produces:
  - `initialPullKey(couchUrl: string, db: string): string` — genutzt von Task 4
  - `uploadIfChanged(store: VaultStore, path: string, bytes: Uint8Array, meta: FileMeta): Promise<boolean>` — genutzt von Task 3

- [ ] **Step 1: Regressionstest schreiben**

`test/initialPull.test.ts`:

```ts
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
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/initialPull.test.ts`
Expected: FAIL — `Cannot find module '../src/store/initialSync'`

- [ ] **Step 3: Modul anlegen**

`src/store/initialSync.ts`:

```ts
import { VaultStore } from "./store";
import { FileMeta } from "./model";
import { contentHash } from "../vault/applyChange";

/**
 * Schlüssel für den Erst-Pull-Riegel (settings.initialPullDone). Bewusst
 * Server UND Datenbankname: derselbe Datenbankname auf einem anderen Server
 * ist ein anderer Datenbestand und braucht einen eigenen Erstabgleich.
 */
export function initialPullKey(couchUrl: string, db: string): string {
  return `${couchUrl.replace(/\/+$/, "")}/${db}`;
}

/**
 * Lädt eine lokale Datei nur hoch, wenn ihr INHALT vom Stand im Store
 * abweicht — Metadaten (mtime, Gerätename) unterscheiden sich zwischen zwei
 * Geräten immer und dürfen keinen Upload auslösen. Rückgabe: true = geschrieben.
 *
 * WICHTIG: Auf einem neuen Gerät muss der Store VOR dem ersten Aufruf per
 * Replikation gefüllt sein. Sonst meldet diese Funktion für jede Datei
 * "geändert", jede Datei bekommt lokal eine eigene Revision, und der
 * anschließende Pull macht daraus flächendeckend Konflikte. Genau das war der
 * Fehler bis 1.2.2 (VaultBridge.start() lief vor der Replikation).
 */
export async function uploadIfChanged(
  store: VaultStore,
  path: string,
  bytes: Uint8Array,
  meta: FileMeta,
): Promise<boolean> {
  const existing = await store.getFile(path);
  if (existing && (await contentHash(existing.bytes)) === (await contentHash(bytes))) {
    return false;
  }
  await store.putFile(path, bytes, meta);
  return true;
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS — insbesondere alle drei Fälle in `test/initialPull.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/store/initialSync.ts test/initialPull.test.ts
git commit -m "feat: initialSync mit uploadIfChanged und Riegel-Schlüssel + Regressionstest"
```

---

### Task 3: Bridge — Erst-Upload-Gate und Lösch-Warteschlange

**Files:**
- Modify: `src/vault/bridge.ts:19-126`, `src/vault/bridge.ts:305-312`

**Interfaces:**
- Consumes: `uploadIfChanged` (Task 2), `FileMeta.device`/`changedAt` (Task 1)
- Produces:
  - `VaultBridge.runInitialUpload(): Promise<void>` — genutzt von Task 4
  - Konstruktor-Parameter `getDeviceName: () => string` an Position 7 (zwischen `setKnown` und `onApplied`)

- [ ] **Step 1: Felder und Konstruktor-Parameter ergänzen**

In `src/vault/bridge.ts` bei den privaten Feldern (nach `private keyMismatchNotified = false;`) einfügen:

```ts
  // Der Erst-Upload (reconcileExisting/reconcileHidden) ist gesperrt, bis der
  // Erst-Pull durch ist — sonst vergleicht er gegen einen leeren Store, lädt
  // alles hoch und der nachfolgende Pull macht daraus auf JEDER Datei einen
  // Konflikt. Freigegeben von runInitialUpload().
  private initialUploadDone = false;
  // Löschungen während des Erst-Pulls: reconcileExisting() sieht nur, was da
  // IST, kann also nichts über inzwischen gelöschte Dateien aussagen. Deshalb
  // gepuffert und nach der Freigabe nachgeholt.
  private queuedDeletes = new Set<string>();
```

Konstruktor-Signatur erweitern — `getDeviceName` **vor** `onApplied`:

```ts
    private readonly getKnown: () => Map<string, string>,
    private readonly setKnown: (m: Map<string, string>) => void,
    private readonly getDeviceName: () => string,
    private readonly onApplied?: (path: string) => void,
```

- [ ] **Step 2: `start()` entkoppeln und Events puffern**

In `start()` den Aufruf `void this.reconcileExisting();` samt Kommentarblock **ersetzen** durch:

```ts
    // Kein Erst-Upload hier: der läuft erst nach dem Erst-Pull über
    // runInitialUpload(). Die Vault-Listener oben sind trotzdem sofort aktiv,
    // damit während des Pulls nichts unbemerkt bleibt.
```

In `onLocalWrite` direkt nach der `shouldSync`-Prüfung einfügen:

```ts
        // Während des Erst-Pulls nicht hochladen. reconcileExisting() holt
        // jede vorhandene Datei danach ohnehin nach, inklusive der hier
        // übergangenen Änderung.
        if (!this.initialUploadDone) return;
```

In `onLocalDelete` direkt nach der `shouldSync`-Prüfung einfügen:

```ts
        if (!this.initialUploadDone) { this.queuedDeletes.add(file.path); return; }
```

- [ ] **Step 3: `runInitialUpload()` hinzufügen und die Reconcile-Methoden absichern**

Neue Methode direkt nach `start()`:

```ts
  /**
   * Gibt den Erst-Upload frei und führt ihn aus. Wird von main.ts erst
   * aufgerufen, wenn der Erst-Pull gegen diese Datenbank abgeschlossen ist —
   * ab dann hat reconcileExisting() einen gefüllten Store zum Vergleichen und
   * lädt nur noch echte Abweichungen hoch. Idempotent.
   */
  async runInitialUpload(): Promise<void> {
    if (this.initialUploadDone) return;
    this.initialUploadDone = true;
    await this.reconcileExisting();
    for (const path of this.queuedDeletes) {
      // Nur löschen, was auch wirklich weg ist — eine Datei kann während des
      // Pulls gelöscht und wieder angelegt worden sein.
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try {
          await this.store.deleteFile(path);
        } catch (e) {
          new Notice(`Vaultbridge: Löschung konnte nicht nachgeholt werden (${path}): ${String(e)}`);
        }
      }
    }
    this.queuedDeletes.clear();
    await this.reconcileHidden();
  }
```

Als erste Zeile von `reconcileExisting()` einfügen:

```ts
    if (!this.initialUploadDone) return; // Erst-Pull noch nicht abgeschlossen
```

Als erste Zeile von `reconcileHidden()` (vor dem `reconcileRunning`-Guard) einfügen:

```ts
    if (!this.initialUploadDone) return; // Erst-Pull noch nicht abgeschlossen
```

- [ ] **Step 4: `metaOf` und den Hidden-Upload auf die neuen Felder umstellen**

`metaOf(file)` ersetzen:

```ts
  private metaOf(file: TFile): FileMeta {
    return {
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      size: file.stat.size,
      mime: "",
      isBinary: !/^(md|txt|json|css|ya?ml)$/i.test(file.extension),
      device: this.getDeviceName(),
      changedAt: Date.now(),
    };
  }
```

In `reconcileHidden()` den `store.putFile`-Aufruf ersetzen:

```ts
          await this.store.putFile(path, bytes, {
            mtime: 0, ctime: 0, size: bytes.length, mime: "",
            isBinary: !/\.(md|txt|json|css|ya?ml|js)$/i.test(path),
            device: this.getDeviceName(),
            changedAt: Date.now(),
          });
```

- [ ] **Step 5: `reconcileExisting()` auf `uploadIfChanged` umstellen**

Import ergänzen:

```ts
import { uploadIfChanged } from "../store/initialSync";
```

Rumpf der Schleife in `reconcileExisting()` ersetzen:

```ts
      try {
        if (!shouldSync(file.path, this.rules, this.configDir)) continue;
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        await uploadIfChanged(this.store, file.path, bytes, this.metaOf(file));
      } catch (e) {
        new Notice(`Vaultbridge: Erst-Abgleich fehlgeschlagen bei ${file.path}: ${String(e)}`);
      }
```

- [ ] **Step 6: Aufrufstelle in `main.ts` mitziehen**

Der Konstruktor hat einen Parameter mehr — die einzige Aufrufstelle muss sofort mit, sonst kompiliert der Zwischenstand nicht. In `src/main.ts:connect()` im `new VaultBridge(...)`-Aufruf zwischen dem `setKnown`-Callback und `(p) => this.onHiddenApplied(p)` einfügen:

```ts
        () => this.settings.deviceName,
```

- [ ] **Step 7: Typprüfung und Lint**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: keine Fehler

Run: `npm run lint`
Expected: keine Errors

- [ ] **Step 8: Commit**

```bash
git add src/vault/bridge.ts src/main.ts
git commit -m "feat: Bridge sperrt den Erst-Upload bis zum Ende des Erst-Pulls"
```

---

### Task 4: `connect()` — Erst-Pull vor Erst-Upload

**Files:**
- Modify: `src/main.ts:23-54` (Settings), `src/main.ts:88-100` (`onSyncStatus`), `src/main.ts:192-238` (`connect`), `src/main.ts:240-258` (`disconnect`)

**Interfaces:**
- Consumes: `initialPullKey` (Task 2), `VaultBridge.runInitialUpload` und Konstruktor-Parameter `getDeviceName` (Task 3)
- Produces:
  - `VaultbridgeSettings.initialPullDone: Record<string, boolean>`
  - `private currentPullKey: string | null` und `private initialPullSettled(): boolean` — genutzt von Task 6

- [ ] **Step 1: Settings-Feld ergänzen**

In `VaultbridgeSettings` (nach `autostart: boolean;`):

```ts
  // Pro Server+Datenbank: wurde gegen diesen Datenbestand schon einmal
  // vollständig gepullt? Erst dann darf der Erst-Upload laufen. Ohne diesen
  // Riegel lädt ein frisch verbundenes Gerät seinen kompletten Vault gegen
  // einen leeren Store hoch und erzeugt auf jeder Datei einen Konflikt.
  initialPullDone: Record<string, boolean>;
```

In `DEFAULT_SETTINGS` (nach `autostart: true,`):

```ts
  initialPullDone: {},
```

- [ ] **Step 2: Importe und Felder ergänzen**

Import in `src/main.ts`:

```ts
import { initialPullKey } from "./store/initialSync";
```

Felder in der Klasse (nach `private rotating = false;`):

```ts
  // Schlüssel (Server+DB) der aktuellen Verbindung, für settings.initialPullDone.
  private currentPullKey: string | null = null;
  // Zählt jede connect()-Runde. connect() hat Await-Punkte (Erst-Pull); nach
  // einem zwischenzeitlichen disconnect()/reconnect darf die alte Runde nichts
  // mehr am neuen Zustand ändern.
  private connectGeneration = 0;
```

- [ ] **Step 3: Hilfsmethoden ergänzen**

Direkt vor `refreshConflicts()` einfügen:

```ts
  /** Ist der Erstabgleich für die aktuelle Verbindung durch? */
  private initialPullSettled(): boolean {
    return !!this.currentPullKey && this.settings.initialPullDone[this.currentPullKey] === true;
  }

  /**
   * Merkt den abgeschlossenen Erst-Pull und gibt den Erst-Upload frei.
   * Aufgerufen nach dem expliziten Pull in connect() UND aus onSyncStatus:
   * ein sauber durchgelaufener Sync-Zyklus ist derselbe Nachweis wie ein
   * abgeschlossener Einzel-Pull. Damit holt sich ein Gerät, das offline
   * gestartet ist, den Erstabgleich beim ersten erfolgreichen Settle.
   */
  private async markInitialPullDone(): Promise<void> {
    const key = this.currentPullKey;
    if (!key || !this.bridge) return;
    if (this.settings.initialPullDone[key] !== true) {
      this.settings.initialPullDone[key] = true;
      await this.saveSettings();
    }
    await this.bridge.runInitialUpload();
  }
```

- [ ] **Step 4: `connect()` umbauen**

Den Block ab `this.bridge = new VaultBridge(` bis einschließlich `void this.checkAdoption();` ersetzen:

```ts
      const generation = ++this.connectGeneration;
      this.currentPullKey = initialPullKey(payload.couchUrl, payload.db);
      this.bridge = new VaultBridge(
        this.app,
        store,
        guard,
        this.settings.rules ?? DEFAULT_RULES,
        this.app.vault.configDir,
        () => new Map(Object.entries(this.settings.known ?? {})),
        (m) => {
          this.settings.known = Object.fromEntries(m);
          if (this.knownSaveTimer !== null) window.clearTimeout(this.knownSaveTimer);
          this.knownSaveTimer = window.setTimeout(() => { this.knownSaveTimer = null; void this.saveSettings(); }, 2000);
        },
        () => this.settings.deviceName,
        (p) => this.onHiddenApplied(p),
      );
      // Listener sofort aktiv, Erst-Upload aber gesperrt (siehe runInitialUpload).
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, { auth: { username: payload.user, password: payload.pass } });
      this.remote = remote;

      if (this.settings.initialPullDone[this.currentPullKey]) {
        await this.bridge.runInitialUpload();
      } else {
        // Erst ziehen, dann schieben. Diese Reihenfolge ist der eigentliche Fix
        // gegen flächendeckende Konflikte beim Hinzufügen eines Geräts.
        this.statusBar.setStatus("active", "Erstabgleich …");
        try {
          await this.localDb.replicate.from(remote);
          if (generation !== this.connectGeneration) return; // zwischenzeitlich getrennt
          await this.bridge.reconcileFromStore();
          await this.markInitialPullDone();
        } catch (e) {
          new Notice(
            "Vaultbridge: Erstabgleich noch nicht möglich — es wird vorerst nichts hochgeladen. " +
              `Sobald die Verbindung steht, wird er automatisch nachgeholt. (${String(e)})`,
            10000,
          );
        }
      }
      if (generation !== this.connectGeneration) return;

      this.startSyncForMode();

      new Notice("Vaultbridge verbunden.");
      void this.refreshConflicts();
      void this.checkAdoption();
```

> `void this.bridge.reconcileHidden();` entfällt hier bewusst — `runInitialUpload()` erledigt das, und vorher wäre es ohnehin gesperrt.

- [ ] **Step 5: `onSyncStatus` das Nachholen beibringen**

Im `if (s === "idle" || s === "paused")`-Block **als erste Anweisung**:

```ts
      void this.markInitialPullDone();
```

- [ ] **Step 6: `disconnect()` zurücksetzen**

In `disconnect()` nach `this.bridge = null;` einfügen:

```ts
    this.currentPullKey = null;
    this.connectGeneration++;
```

- [ ] **Step 7: Prüfen**

Run: `npx tsc --noEmit --skipLibCheck`, `npm run lint`, `npm test`
Expected: alle drei sauber

- [ ] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "fix: Erst-Pull vor Erst-Upload — keine Phantom-Konflikte mehr bei neuen Geräten"
```

---

### Task 5: Gerätename-Vorschlag

**Files:**
- Create: `src/setup/deviceName.ts`
- Create: `test/deviceName.test.ts`
- Modify: `src/main.ts` (Vorbelegung in `connect()`)
- Modify: `src/ui/SettingsTab.ts:71-79`

**Interfaces:**
- Consumes: `connect()` aus Task 4 (die Vorbelegung wird dort eingehängt)
- Produces:
  - `PlatformFlags { isMacOS, isWin, isIosApp, isAndroidApp, isTablet }`
  - `defaultDeviceName(flags: PlatformFlags, suffix: string): string`
  - `randomDeviceSuffix(): string`
  - gefüllter `settings.deviceName` — Voraussetzung dafür, dass `metaOf()` (Task 3) einen brauchbaren Namen schreibt

- [ ] **Step 1: Test schreiben**

`test/deviceName.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultDeviceName, randomDeviceSuffix } from "../src/setup/deviceName";

const NONE = { isMacOS: false, isWin: false, isIosApp: false, isAndroidApp: false, isTablet: false };

describe("defaultDeviceName", () => {
  it("erkennt macOS", () => {
    expect(defaultDeviceName({ ...NONE, isMacOS: true }, "7f3")).toBe("Mac-7f3");
  });

  it("erkennt Windows", () => {
    expect(defaultDeviceName({ ...NONE, isWin: true }, "a12")).toBe("Windows-a12");
  });

  it("unterscheidet iPhone und iPad", () => {
    expect(defaultDeviceName({ ...NONE, isIosApp: true }, "4c8")).toBe("iPhone-4c8");
    expect(defaultDeviceName({ ...NONE, isIosApp: true, isTablet: true }, "4c8")).toBe("iPad-4c8");
  });

  it("erkennt Android", () => {
    expect(defaultDeviceName({ ...NONE, isAndroidApp: true }, "9d1")).toBe("Android-9d1");
  });

  it("fällt auf Linux zurück, wenn keine Plattform passt", () => {
    expect(defaultDeviceName(NONE, "b04")).toBe("Linux-b04");
  });

  it("bevorzugt die Mobil-Plattform, wenn beide Flags gesetzt sind", () => {
    // Auf iOS meldet Obsidian teils zusätzlich isMacOS — das Gerät ist trotzdem ein iPhone.
    expect(defaultDeviceName({ ...NONE, isMacOS: true, isIosApp: true }, "111")).toBe("iPhone-111");
  });
});

describe("randomDeviceSuffix", () => {
  it("liefert drei Hex-Zeichen", () => {
    expect(randomDeviceSuffix()).toMatch(/^[0-9a-f]{3}$/);
  });

  it("liefert bei wiederholtem Aufruf nicht immer dasselbe", () => {
    const seen = new Set(Array.from({ length: 40 }, () => randomDeviceSuffix()));
    expect(seen.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/deviceName.test.ts`
Expected: FAIL — `Cannot find module '../src/setup/deviceName'`

- [ ] **Step 3: Modul anlegen**

`src/setup/deviceName.ts`:

```ts
/**
 * Plattform-Flags, wie Obsidians `Platform` sie liefert. Bewusst als Parameter
 * statt `import { Platform } from "obsidian"` — so bleibt dieses Modul unter
 * vitest testbar (dort gibt es kein "obsidian").
 */
export interface PlatformFlags {
  isMacOS: boolean;
  isWin: boolean;
  isIosApp: boolean;
  isAndroidApp: boolean;
  isTablet: boolean;
}

/**
 * Vorschlag für den Gerätenamen. Das Suffix ist Absicht: ohne es wären zwei
 * MacBooks in der Konfliktansicht nicht auseinanderzuhalten. Der Nutzer kann
 * den Namen in den Einstellungen jederzeit überschreiben.
 */
export function defaultDeviceName(p: PlatformFlags, suffix: string): string {
  // Mobil zuerst prüfen: auf iOS meldet Obsidian teilweise zusätzlich isMacOS.
  const base = p.isIosApp
    ? (p.isTablet ? "iPad" : "iPhone")
    : p.isAndroidApp
      ? "Android"
      : p.isMacOS
        ? "Mac"
        : p.isWin
          ? "Windows"
          : "Linux";
  return `${base}-${suffix}`;
}

/** Drei Hex-Zeichen zur Unterscheidung baugleicher Geräte. */
export function randomDeviceSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 3);
}
```

- [ ] **Step 4: Vorbelegung in `connect()` einhängen**

Import in `src/main.ts` ergänzen:

```ts
import { defaultDeviceName, randomDeviceSuffix } from "./setup/deviceName";
```

In `connect()` direkt nach der Zeile `this.currentPullKey = initialPullKey(payload.couchUrl, payload.db);` einfügen:

```ts
      // Erst beim Verbinden vorbelegen, nicht beim Laden: hier steht fest, dass
      // das Gerät wirklich am Sync teilnimmt, und der Name landet ab sofort in
      // jeder geschriebenen Datei.
      if (!this.settings.deviceName) {
        this.settings.deviceName = defaultDeviceName(
          {
            isMacOS: Platform.isMacOS,
            isWin: Platform.isWin,
            isIosApp: Platform.isIosApp,
            isAndroidApp: Platform.isAndroidApp,
            isTablet: Platform.isTablet,
          },
          randomDeviceSuffix(),
        );
        await this.saveSettings();
      }
```

- [ ] **Step 5: Beschreibung im Einstellungs-Tab präzisieren**

In `src/ui/SettingsTab.ts` die Gerätename-Einstellung ersetzen:

```ts
    new Setting(containerEl)
      .setName("Gerätename")
      .setDesc(
        "Wird bei jeder Änderung mitgespeichert (verschlüsselt) und in der Konfliktansicht angezeigt, " +
          "damit du siehst, auf welchem Gerät eine Abweichung entstanden ist. Beim ersten Verbinden " +
          "automatisch vorbelegt.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }),
      );
```

- [ ] **Step 6: Alles prüfen**

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit --skipLibCheck`
Expected: keine Fehler

Run: `npm run lint`
Expected: keine Errors

- [ ] **Step 7: Commit**

```bash
git add src/setup/deviceName.ts test/deviceName.test.ts src/main.ts src/ui/SettingsTab.ts
git commit -m "feat: automatischer Gerätename-Vorschlag beim ersten Verbinden"
```

---

## Stufe 2 — Automatische Konfliktauflösung

### Task 6: Auflösungsplaner

**Files:**
- Create: `src/conflicts/autoResolve.ts`
- Create: `test/autoResolve.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `ConflictBranch { rev: string; hash: string; changedAt: number; deleted: boolean }`
  - `AutoResolvePlan` (Union, siehe unten)
  - `planAutoResolve(winner: ConflictBranch, others: ConflictBranch[]): AutoResolvePlan`
  — genutzt von Task 8

- [ ] **Step 1: Test schreiben**

`test/autoResolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planAutoResolve, ConflictBranch } from "../src/conflicts/autoResolve";

function branch(rev: string, hash: string, changedAt: number, deleted = false): ConflictBranch {
  return { rev, hash, changedAt, deleted };
}

describe("planAutoResolve", () => {
  it("liefert null, wenn es keinen Konfliktzweig gibt", () => {
    expect(planAutoResolve(branch("2-a", "H1", 100), [])).toBeNull();
  });

  it("erkennt inhaltsgleiche Zweige und verwirft nur die Verlierer", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H1", 200)]);
    expect(plan).toEqual({ kind: "identical", keep: "2-a", prune: ["2-b"] });
  });

  it("behandelt beliebig viele inhaltsgleiche Zweige", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [
      branch("2-b", "H1", 200),
      branch("2-c", "H1", 50),
    ]);
    expect(plan).toEqual({ kind: "identical", keep: "2-a", prune: ["2-b", "2-c"] });
  });

  it("wertet gleichen Hash bei unterschiedlichem deleted-Flag NICHT als identisch", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H1", 200, true)]);
    expect(plan?.kind).toBe("newest-wins");
  });

  it("lässt bei echter Abweichung den neueren changedAt gewinnen", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H2", 200)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-b",
      prune: ["2-a"],
      loser: branch("2-a", "H1", 100),
    });
  });

  it("behält den Gewinner, wenn er selbst der neuere ist", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 300), [branch("2-b", "H2", 200)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-a",
      prune: ["2-b"],
      loser: branch("2-b", "H2", 200),
    });
  });

  it("entscheidet bei gleichem changedAt über die lexikographisch größte Revision", () => {
    const plan = planAutoResolve(branch("2-aaa", "H1", 100), [branch("2-zzz", "H2", 100)]);
    expect(plan?.keep).toBe("2-zzz");
  });

  it("verwirft inhaltsgleiche Zweige mit, wenn ein dritter abweicht", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 300), [
      branch("2-b", "H1", 100), // identisch zum Gewinner
      branch("2-c", "H2", 200), // echte Abweichung, aber älter
    ]);
    expect(plan?.kind).toBe("newest-wins");
    expect(plan?.keep).toBe("2-a");
    expect(new Set(plan!.prune)).toEqual(new Set(["2-b", "2-c"]));
    expect((plan as { loser: ConflictBranch }).loser.rev).toBe("2-c");
  });

  it("wählt als Verlierer für die Sicherung den neuesten abweichenden Zweig", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 500), [
      branch("2-b", "H2", 100),
      branch("2-c", "H3", 400),
    ]);
    expect((plan as { loser: ConflictBranch }).loser.rev).toBe("2-c");
  });

  it("behandelt einen fehlenden changedAt (0) als ältesten Stand", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 0), [branch("2-b", "H2", 1)]);
    expect(plan?.keep).toBe("2-b");
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/autoResolve.test.ts`
Expected: FAIL — `Cannot find module '../src/conflicts/autoResolve'`

- [ ] **Step 3: Modul anlegen**

`src/conflicts/autoResolve.ts`:

```ts
/** Ein Konfliktzweig, reduziert auf das, was für die Entscheidung zählt. */
export interface ConflictBranch {
  /** CouchDB-Revision dieses Zweigs. */
  rev: string;
  /** SHA-256 der ENTSCHLÜSSELTEN Dateibytes — nicht des Dokuments. */
  hash: string;
  /** FileMeta.changedAt, 0 wenn unbekannt (Dokumente aus 1.2.x). */
  changedAt: number;
  deleted: boolean;
}

export type AutoResolvePlan =
  | { kind: "identical"; keep: string; prune: string[] }
  | { kind: "newest-wins"; keep: string; prune: string[]; loser: ConflictBranch }
  | null;

function sameContent(a: ConflictBranch, b: ConflictBranch): boolean {
  return a.hash === b.hash && a.deleted === b.deleted;
}

/**
 * Neuer gewinnt; bei gleichem Zeitstempel die lexikographisch größte Revision.
 * Der Tiebreaker ist bewusst derselbe, den CouchDB selbst zur Gewinnerwahl
 * benutzt — dadurch kommen alle Geräte unabhängig voneinander zum gleichen
 * Ergebnis und es entsteht kein Ping-Pong.
 */
function newer(a: ConflictBranch, b: ConflictBranch): ConflictBranch {
  if (a.changedAt !== b.changedAt) return a.changedAt > b.changedAt ? a : b;
  return a.rev > b.rev ? a : b;
}

/**
 * Plant die automatische Auflösung eines Konflikts.
 *
 * - Sind ALLE Zweige inhaltsgleich, ist der Konflikt bedeutungslos: die
 *   Verlierer-Revisionen werden verworfen, GESCHRIEBEN WIRD NICHTS. Das ist
 *   der wesentliche Unterschied zur alten Sammel-Auflösung, die eine neue
 *   Revision schrieb und damit bei zwei gleichzeitig auflösenden Geräten
 *   sofort den nächsten Konflikt erzeugte.
 * - Sonst gewinnt der neueste Zweig; inhaltsgleiche Zweige werden mit
 *   verworfen, der neueste ABWEICHENDE Zweig wird als `loser` gemeldet, damit
 *   der Aufrufer ihn als Sidecar sichern kann.
 *
 * @param winner Der von CouchDB gewählte Gewinner (das gültige Dokument).
 * @param others Die Zweige aus `_conflicts`.
 */
export function planAutoResolve(winner: ConflictBranch, others: ConflictBranch[]): AutoResolvePlan {
  if (others.length === 0) return null;

  if (others.every((o) => sameContent(winner, o))) {
    return { kind: "identical", keep: winner.rev, prune: others.map((o) => o.rev) };
  }

  const all = [winner, ...others];
  const keep = all.reduce(newer);
  const losers = all.filter((b) => b.rev !== keep.rev);
  // Für die Sicherung zählt nur, was inhaltlich wirklich verloren geht.
  // Mindestens ein solcher Zweig existiert hier garantiert, sonst hätte der
  // "identical"-Zweig oben schon gegriffen.
  const loser = losers.filter((b) => !sameContent(keep, b)).reduce(newer);

  return { kind: "newest-wins", keep: keep.rev, prune: losers.map((b) => b.rev), loser };
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/conflicts/autoResolve.ts test/autoResolve.test.ts
git commit -m "feat: planAutoResolve — Auflösungsplan für inhaltsgleiche und abweichende Zweige"
```

---

### Task 7: `pruneConflictRevs` und `deleted` je Zweig

**Files:**
- Modify: `src/store/store.ts:14-18` (`ConflictVersion`), `src/store/store.ts:131-141` (`readNoteRev`), `src/store/store.ts:166-194` (`getConflict`), neue Methode nach `resolveConflict`
- Create: `test/pruneConflict.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `ConflictVersion.deleted: boolean`
  - `VaultStore.pruneConflictRevs(id: string, revs: string[]): Promise<void>`
  — genutzt von Task 8

- [ ] **Step 1: Test schreiben**

`test/pruneConflict.test.ts`:

```ts
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
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/pruneConflict.test.ts`
Expected: FAIL — `a.pruneConflictRevs is not a function` bzw. TypeScript-Fehler zu `deleted`

- [ ] **Step 3: `ConflictVersion` und `readNoteRev` erweitern**

`src/store/store.ts` — `ConflictVersion`:

```ts
export interface ConflictVersion {
  rev: string;
  bytes: Uint8Array;
  meta: FileMeta;
  /** Ist dieser Zweig eine Löschung? Zwei Zweige mit gleichem (leeren) Inhalt,
   *  aber unterschiedlichem Flag sind NICHT dasselbe. */
  deleted: boolean;
}
```

`readNoteRev` ersetzen:

```ts
  async readNoteRev(
    id: string,
    rev: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta; deleted: boolean } | null> {
    try {
      const note = await this.db.get<NoteDoc>(id, { rev });
      const decoded = await this.tryDecode(note);
      return decoded ? { ...decoded, deleted: !!note.deleted } : null;
    } catch {
      return null;
    }
  }
```

In `getConflict` die beiden Stellen anpassen:

```ts
    const remotes: ConflictVersion[] = [];
    for (const rev of winning._conflicts) {
      const version = await this.readNoteRev(id, rev);
      if (version) remotes.push({ rev, bytes: version.bytes, meta: version.meta, deleted: version.deleted });
    }
    return {
      id,
      path: local.path,
      isBinary: local.meta.isBinary,
      local: { rev: winning._rev, bytes: local.bytes, meta: local.meta, deleted: !!winning.deleted },
      remotes,
    };
```

- [ ] **Step 4: `pruneConflictRevs` hinzufügen**

Direkt nach `resolveConflict` einfügen:

```ts
  /**
   * Verwirft Konfliktzweige, OHNE eine neue Revision zu schreiben. Für den Fall,
   * dass die Zweige inhaltsgleich sind — dann ist Neuschreiben nicht nur
   * überflüssig, sondern schädlich: zwei Geräte, die gleichzeitig auflösen,
   * erzeugen damit sofort den nächsten Konflikt. Ein 404 gilt als Erfolg
   * (bereits von einem anderen Gerät entfernt).
   */
  async pruneConflictRevs(id: string, revs: string[]): Promise<void> {
    let firstError: unknown = null;
    for (const rev of revs) {
      try {
        await this.db.remove(id, rev);
      } catch (e) {
        const status = (e as { status?: number }).status;
        const name = (e as { name?: string }).name;
        if (status === 404 || name === "not_found") continue;
        firstError = firstError ?? e;
      }
    }
    if (firstError) throw toError(firstError);
  }
```

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test`
Expected: PASS — auch `test/history.test.ts` und `test/storeConflict.test.ts` müssen weiter grün sein (`readNoteRev` liefert jetzt ein Feld mehr, was bestehende Aufrufer nicht stört).

- [ ] **Step 6: Commit**

```bash
git add src/store/store.ts test/pruneConflict.test.ts
git commit -m "feat: pruneConflictRevs verwirft Zweige ohne Neuschreiben, deleted je Zweig"
```

---

### Task 8: Automatische Auflösung im Plugin verdrahten

**Files:**
- Modify: `src/main.ts` — Importe, neues Feld, neue Methoden, `refreshConflicts`, `resolveIdenticalConflicts`

**Interfaces:**
- Consumes: `planAutoResolve`/`ConflictBranch` (Task 6), `pruneConflictRevs`/`ConflictVersion.deleted` (Task 7), `initialPullSettled` (Task 4), `contentHash` (`src/vault/applyChange.ts`)
- Produces: `VaultbridgePlugin.autoResolveConflicts(): Promise<void>`

- [ ] **Step 1: Importe und Feld ergänzen**

```ts
import { planAutoResolve, ConflictBranch } from "./conflicts/autoResolve";
import { contentHash } from "./vault/applyChange";
import type { ConflictVersion } from "./store/store";
```

> `EchoGuard` wird bereits aus `./vault/applyChange` importiert — den bestehenden Import um `contentHash` erweitern, statt eine zweite Import-Zeile anzulegen.

Neues Feld bei den übrigen Guards, direkt neben `private rotating = false;`:

```ts
  // Verhindert, dass zwei Settles gleichzeitig auflösen.
  private autoResolving = false;
```

- [ ] **Step 2: `autoResolveConflicts()` hinzufügen**

Direkt vor `refreshConflicts()`:

```ts
  /**
   * Löst Konflikte automatisch auf, sobald das gefahrlos möglich ist:
   * inhaltsgleiche Zweige werden still verworfen, bei echten Abweichungen
   * gewinnt die neuere Fassung und die unterlegene wird als Sidecar gesichert
   * und gemeldet. Läuft bei jedem Sync-Settle.
   *
   * Gated auf den Erstabgleich: solange der nicht durch ist, kennt dieses Gerät
   * den Datenbestand nur teilweise und dürfte gar nichts entscheiden.
   */
  async autoResolveConflicts(): Promise<void> {
    const store = this.store;
    if (!store || this.autoResolving || this.rotating) return;
    if (!this.initialPullSettled()) return;
    this.autoResolving = true;
    try {
      for (const id of await store.listConflicts()) {
        try {
          const c = await store.getConflict(id);
          if (!c) continue;
          const versions = [c.local, ...c.remotes];
          const branches = new Map<string, ConflictVersion>();
          for (const v of versions) branches.set(v.rev, v);
          const toBranch = async (v: ConflictVersion): Promise<ConflictBranch> => ({
            rev: v.rev,
            hash: await contentHash(v.bytes),
            // changedAt bevorzugt; Dokumente aus 1.2.x haben es nicht, dann
            // ersatzweise mtime (bei versteckten Dateien 0 — dann entscheidet
            // der Revisions-Tiebreaker).
            changedAt: v.meta.changedAt ?? v.meta.mtime ?? 0,
            deleted: v.deleted,
          });
          const winner = await toBranch(c.local);
          const others: ConflictBranch[] = [];
          for (const r of c.remotes) others.push(await toBranch(r));

          const plan = planAutoResolve(winner, others);
          if (!plan) continue;

          if (plan.keep === c.local.rev) {
            // Der gültige Zweig bleibt gültig — Verwerfen genügt, kein Schreiben.
            await store.pruneConflictRevs(c.id, plan.prune);
          } else {
            const keep = branches.get(plan.keep);
            if (!keep) continue;
            await store.resolveConflict(c.id, c.path, keep.bytes, keep.meta, plan.prune);
          }

          if (plan.kind === "newest-wins") {
            const loser = branches.get(plan.loser.rev);
            const keep = branches.get(plan.keep);
            if (loser) await this.saveConflictSidecar(c.path, loser.bytes);
            new Notice(
              `Vaultbridge: „${c.path}" wurde auf beiden Seiten geändert. Übernommen wurde die neuere Fassung ` +
                `von ${this.deviceLabel(keep?.meta.device)}; die Fassung von ${this.deviceLabel(loser?.meta.device)} ` +
                `liegt als „${c.path}.vaultbridge-konflikt" im Vault.`,
              15000,
            );
          }
        } catch (e) {
          // Eine Datei darf den Durchlauf nicht abbrechen.
          new Notice(`Vaultbridge: Konflikt konnte nicht automatisch gelöst werden (${id}): ${String(e)}`);
        }
      }
    } finally {
      this.autoResolving = false;
    }
  }

  /** Anzeigename eines Geräts, mit Rückfallwert für Dokumente aus 1.2.x. */
  private deviceLabel(device: string | undefined): string {
    return device && device.length > 0 ? device : "einem unbekannten Gerät";
  }

  /** Sichert eine unterlegene Fassung neben der Datei, damit nichts verloren geht. */
  private async saveConflictSidecar(path: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.app.vault.adapter.writeBinary(`${path}.vaultbridge-konflikt`, bytes.slice().buffer);
    } catch (e) {
      new Notice(`Vaultbridge: Sicherung der unterlegenen Fassung fehlgeschlagen (${path}): ${String(e)}`);
    }
  }
```

- [ ] **Step 3: In `refreshConflicts()` einhängen**

Den Rumpf des `try`-Blocks in `refreshConflicts()` mit dem Auto-Resolve beginnen lassen:

```ts
    try {
      await this.autoResolveConflicts();
      const ids = await this.store.listConflicts();
```

- [ ] **Step 4: `resolveIdenticalConflicts()` auf den Planer umstellen**

Der Befehl und der Button in der Konfliktliste bleiben, nutzen aber dieselbe Logik. Methode ersetzen:

```ts
  /**
   * Manuelles Nachfassen für den Fall, dass jemand nicht auf den nächsten
   * Sync-Settle warten will. Nutzt exakt dieselbe Logik wie der Automatismus.
   */
  async resolveIdenticalConflicts(): Promise<void> {
    if (!this.store) { new Notice("Vaultbridge: nicht verbunden."); return; }
    if (!this.initialPullSettled()) {
      new Notice("Vaultbridge: Erstabgleich läuft noch — bitte kurz warten.");
      return;
    }
    const before = (await this.store.listConflicts()).length;
    await this.autoResolveConflicts();
    const after = (await this.store.listConflicts()).length;
    new Notice(
      `Vaultbridge: ${before - after} Konflikte gelöst` + (after > 0 ? `, ${after} verbleiben.` : "."),
      8000,
    );
    this.activeConflictId = null;
    await this.refreshConflicts();
    this.renderConflictDiff();
  }
```

Der Import von `ConflictSession` in `main.ts` wird dadurch ungenutzt — Zeile `import { ConflictSession } from "./conflicts/session";` entfernen (ESLint meldet sie sonst).

- [ ] **Step 5: Prüfen**

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit --skipLibCheck` und `npm run lint`
Expected: keine Fehler, keine Errors

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat: Konflikte werden bei jedem Settle automatisch aufgelöst"
```

---

## Stufe 3 — Gerätezuordnung in der Oberfläche

### Task 9: Gerät und Zeitstempel in Vergleichsansicht und Liste

**Files:**
- Modify: `src/ui/ConflictDiffView.ts:49-68` (Kopf), `:182-188` (Spaltenköpfe), `:231-242` (Binär-Karten)
- Modify: `src/ui/ConflictListView.ts:52-66`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `ConflictVersion` mit `meta.device`/`meta.changedAt` (Task 1, 7)
- Produces: nichts für spätere Tasks

- [ ] **Step 1: Formatierungs-Helfer in `ConflictDiffView` anlegen**

Als private Methoden in `ConflictDiffView`:

```ts
  /** „Mac-7f3 · 6. Aug. 2026, 14:23" — mit Rückfallwerten für alte Dokumente. */
  private sideLabel(meta: import("../store/model").FileMeta): string {
    const device = meta.device && meta.device.length > 0 ? meta.device : "Gerät unbekannt";
    const stamp = meta.changedAt ?? (meta.mtime > 0 ? meta.mtime : undefined);
    if (stamp === undefined) return device;
    return `${device} · ${new Date(stamp).toLocaleString()}`;
  }

  private deviceOf(meta: import("../store/model").FileMeta): string {
    return meta.device && meta.device.length > 0 ? meta.device : "einem unbekannten Gerät";
  }
```

- [ ] **Step 2: Kopfzeile um die Geräteangabe ergänzen**

In `render()` direkt nach `header.createDiv({ cls: "vb-cv-path", text: conflict.path });` einfügen:

```ts
    const devices = [conflict.local, ...conflict.remotes].map((v) => this.deviceOf(v.meta));
    header.createDiv({
      cls: "vb-cv-devices",
      text:
        conflict.remotes.length === 1
          ? `Geändert auf ${devices[0]} (A) und ${devices[1]} (B)`
          : `Geändert auf: ${devices.join(", ")}`,
    });
```

- [ ] **Step 3: Spaltenköpfe des Diffs erweitern**

`renderDiff` bekommt die Beschriftungen als Parameter. Signatur und Kopfzeilen ersetzen:

```ts
  private renderDiff(root: HTMLElement, session: ConflictSession, labels: { local: string; remote: string }): void {
    const table = root.createDiv({ cls: "vb-diff" });

    const colHead = table.createDiv({ cls: "vb-diff-head" });
    const cellL = colHead.createDiv({ cls: "vb-diff-head-cell vb-side-local" });
    cellL.createDiv({ text: "Aktuell (A)" });
    cellL.createDiv({ cls: "vb-diff-head-sub", text: labels.local });
    const cellR = colHead.createDiv({ cls: "vb-diff-head-cell vb-side-remote" });
    cellR.createDiv({ text: "Konflikt (B)" });
    cellR.createDiv({ cls: "vb-diff-head-sub", text: labels.remote });
```

Der Aufruf in `showCompare()`:

```ts
      this.renderDiff(body, session, {
        local: this.sideLabel(conflict.local.meta),
        remote: this.sideLabel(conflict.remotes[0].meta),
      });
```

- [ ] **Step 4: Binär-Karten erweitern**

`renderBinary` ersetzen:

```ts
  private renderBinary(
    root: HTMLElement,
    conflict: {
      local: { bytes: Uint8Array; meta: import("../store/model").FileMeta };
      remotes: { bytes: Uint8Array; meta: import("../store/model").FileMeta }[];
    },
  ): void {
    const cards = root.createDiv({ cls: "vb-binary" });
    const local = cards.createDiv({ cls: "vb-card" });
    local.createEl("b", { text: "Aktuell (A)" });
    local.createDiv({ cls: "vb-card-sub", text: this.sideLabel(conflict.local.meta) });
    local.createDiv({ text: `${conflict.local.bytes.length} Bytes` });
    const remote = cards.createDiv({ cls: "vb-card" });
    remote.createEl("b", { text: "Konflikt (B)" });
    remote.createDiv({ cls: "vb-card-sub", text: this.sideLabel(conflict.remotes[0].meta) });
    remote.createDiv({ text: `${conflict.remotes[0].bytes.length} Bytes` });
  }
```

- [ ] **Step 5: Konfliktliste um die Gerätezeile ergänzen**

In `ConflictListView.render()` nach `item.createDiv({ cls: "vb-cv-item-name", ... });` einfügen:

```ts
      if (conflict) {
        const names = [conflict.local, ...conflict.remotes].map((v) =>
          v.meta.device && v.meta.device.length > 0 ? v.meta.device : "unbekannt",
        );
        item.createDiv({ cls: "vb-cv-item-devices", text: names.join(" ↔ ") });
      }
```

- [ ] **Step 6: Stile ergänzen**

An `styles.css` anhängen:

```css
/* Gerätezuordnung in Konfliktliste und -vergleich */
.vb-cv-devices { color: var(--text-muted); font-size: 0.85em; margin-top: 2px; }
.vb-cv-item-devices { color: var(--text-faint); font-size: 0.75em; line-height: 1.3; margin-top: 2px; }
.vb-diff-head-sub { color: var(--text-muted); font-weight: 400; font-size: 0.9em; }
.vb-card-sub { color: var(--text-muted); font-size: 0.85em; margin: 2px 0 4px; }
```

- [ ] **Step 7: Prüfen**

Run: `npx tsc --noEmit --skipLibCheck`, `npm run lint`, `npm test`
Expected: alle drei sauber

- [ ] **Step 8: Commit**

```bash
git add src/ui/ConflictDiffView.ts src/ui/ConflictListView.ts styles.css
git commit -m "feat: Vergleichsansicht und Konfliktliste zeigen Gerät und Änderungszeit"
```

---

## Stufe 4 — Setup-Hilfe und Verbindungsart

### Task 10: CouchDB-URL prüfen

**Files:**
- Create: `src/setup/couchUrl.ts`
- Create: `test/couchUrl.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `UrlHint { level: "ok" | "warn" | "error"; message: string }`
  - `UrlCheck { hints: UrlHint[]; normalized: string }`
  - `checkCouchUrl(raw: string): UrlCheck`
  - `isLocalHostname(host: string): boolean`
  — genutzt von Task 11 und Task 13

- [ ] **Step 1: Test schreiben**

`test/couchUrl.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkCouchUrl, isLocalHostname } from "../src/setup/couchUrl";

const levels = (raw: string) => checkCouchUrl(raw).hints.map((h) => h.level);
const text = (raw: string) => checkCouchUrl(raw).hints.map((h) => h.message).join(" | ");

describe("checkCouchUrl", () => {
  it("meldet zu einer leeren Eingabe nichts", () => {
    expect(checkCouchUrl("   ")).toEqual({ hints: [], normalized: "" });
  });

  it("verlangt ein Protokoll", () => {
    expect(levels("192.168.20.30:5984")).toContain("error");
    expect(text("192.168.20.30:5984")).toContain("http://");
  });

  it("weist den Datenbanknamen in der URL ab", () => {
    expect(levels("https://couch.example.com/vault")).toContain("error");
    expect(text("https://couch.example.com/vault")).toContain("Feld darunter");
  });

  it("erkennt die Fauxton-Oberfläche", () => {
    expect(text("http://host:5984/_utils")).toContain("Fauxton");
    expect(text("http://host:5984/_utils/")).toContain("Fauxton");
  });

  it("akzeptiert die Server-Wurzel und normalisiert den Schrägstrich", () => {
    const res = checkCouchUrl("https://couch.example.com/");
    expect(res.normalized).toBe("https://couch.example.com");
    expect(res.hints.every((h) => h.level === "ok")).toBe(true);
  });

  it("entfernt umgebenden Leerraum", () => {
    expect(checkCouchUrl("  https://couch.example.com  ").normalized).toBe("https://couch.example.com");
  });

  it("erinnert bei http ohne Port an 5984", () => {
    expect(text("http://192.168.20.30")).toContain("5984");
  });

  it("warnt bei http auf einem öffentlichen Host", () => {
    expect(text("http://couch.example.com:5984")).toContain("Unverschlüsselt");
  });

  it("warnt nicht wegen fehlender Verschlüsselung bei einer lokalen Adresse", () => {
    expect(text("http://192.168.20.30:5984")).not.toContain("Unverschlüsselt");
  });

  it("weist bei lokalen Adressen auf die Verbindungsart hin", () => {
    expect(text("http://192.168.20.30:5984")).toContain("Verbindungsart");
    expect(text("http://localhost:5984")).toContain("Verbindungsart");
  });

  it("behält den Port in der normalisierten Form", () => {
    expect(checkCouchUrl("http://192.168.20.30:5984").normalized).toBe("http://192.168.20.30:5984");
  });

  it("meldet eine unbrauchbare Eingabe als Fehler", () => {
    expect(levels("https://")).toContain("error");
  });
});

describe("isLocalHostname", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "192.168.20.30", "172.16.0.1", "172.31.255.4", "qpim.local"])(
    "erkennt %s als lokal",
    (host) => expect(isLocalHostname(host)).toBe(true),
  );

  it.each(["couch.example.com", "172.32.0.1", "8.8.8.8", "11.0.0.1"])(
    "erkennt %s als nicht lokal",
    (host) => expect(isLocalHostname(host)).toBe(false),
  );
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/couchUrl.test.ts`
Expected: FAIL — `Cannot find module '../src/setup/couchUrl'`

- [ ] **Step 3: Modul anlegen**

`src/setup/couchUrl.ts`:

```ts
export interface UrlHint {
  level: "ok" | "warn" | "error";
  message: string;
}

export interface UrlCheck {
  hints: UrlHint[];
  /** Server-Wurzel ohne Pfad und ohne abschließenden Schrägstrich. */
  normalized: string;
}

const LOCAL_HOST =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[::1\]|.+\.local)$/i;

/** Adressen im eigenen Netz — genau die, die Chromiums Local Network Access sperrt. */
export function isLocalHostname(host: string): boolean {
  return LOCAL_HOST.test(host);
}

/**
 * Prüft die im Setup eingetragene CouchDB-URL und liefert verständliche
 * Hinweise. Absichtlich rein: dieselbe Prüfung läuft live beim Tippen im
 * Generator und lässt sich vollständig unit-testen.
 */
export function checkCouchUrl(raw: string): UrlCheck {
  const hints: UrlHint[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { hints, normalized: "" };

  if (!/^https?:\/\//i.test(trimmed)) {
    hints.push({
      level: "error",
      message: "Muss mit http:// oder https:// beginnen — z. B. http://192.168.20.30:5984",
    });
    return { hints, normalized: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    hints.push({ level: "error", message: "Das ist keine gültige URL." });
    return { hints, normalized: trimmed };
  }
  if (!url.hostname) {
    hints.push({ level: "error", message: "Es fehlt der Servername — z. B. http://192.168.20.30:5984" });
    return { hints, normalized: trimmed };
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (/^\/_utils/i.test(path)) {
    hints.push({
      level: "error",
      message:
        "Das ist Fauxton, die Weboberfläche von CouchDB. Hier gehört die Server-Wurzel hin — also ohne /_utils.",
    });
  } else if (path.length > 0) {
    hints.push({
      level: "error",
      message: `„${path.replace(/^\//, "")}" gehört nicht in die URL — der Datenbankname kommt in das Feld darunter.`,
    });
  }

  const local = isLocalHostname(url.hostname);
  if (url.protocol === "http:" && !url.port) {
    hints.push({ level: "warn", message: "Kein Port angegeben — CouchDB lauscht standardmäßig auf 5984." });
  }
  if (url.protocol === "http:" && !local) {
    hints.push({
      level: "warn",
      message: "Unverschlüsselt (http). Für den echten Betrieb einen Reverse-Proxy mit TLS davorschalten.",
    });
  }
  if (local) {
    hints.push({
      level: "warn",
      message:
        "Adresse im lokalen Netz. Blockiert Obsidian die Verbindung, stell in den Einstellungen die " +
        "Verbindungsart auf „Obsidian (requestUrl)\" um.",
    });
  }

  if (hints.length === 0) hints.push({ level: "ok", message: "Sieht gut aus." });
  return { hints, normalized: `${url.protocol}//${url.host}` };
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/setup/couchUrl.ts test/couchUrl.test.ts
git commit -m "feat: checkCouchUrl prüft die Server-URL und erklärt die typischen Fehler"
```

---

### Task 11: URL-Hilfe im Generator

**Files:**
- Modify: `src/ui/GeneratorModal.ts:36-96`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `checkCouchUrl` (Task 10), `testConnection` (`src/setup/connection.ts`)
- Produces: nichts für spätere Tasks

- [ ] **Step 1: Importe und Feld ergänzen**

```ts
import { checkCouchUrl } from "../setup/couchUrl";
import { testConnection } from "../setup/connection";
```

Feld in der Klasse:

```ts
  private urlHintsEl!: HTMLElement;
```

- [ ] **Step 2: URL-Feld mit Beschreibung und Live-Prüfung**

Die bestehende `CouchDB-URL`-Einstellung ersetzen:

```ts
    new Setting(contentEl)
      .setName("CouchDB-URL")
      .setDesc(
        "Nur die Server-Wurzel — z. B. https://couch.example.com oder http://192.168.20.30:5984. " +
          "Ohne Datenbanknamen, ohne /_utils und ohne abschließenden Schrägstrich.",
      )
      .addText((t) =>
        t.setPlaceholder("http://192.168.20.30:5984").onChange((v) => {
          this.couchUrl = v.trim();
          this.renderUrlHints();
        }),
      );
    this.urlHintsEl = contentEl.createDiv({ cls: "vb-url-hints" });
```

- [ ] **Step 3: `renderUrlHints()` und „Verbindung testen" ergänzen**

Neue Methoden:

```ts
  /** Live-Rückmeldung zur eingetippten URL. */
  private renderUrlHints(): void {
    const el = this.urlHintsEl;
    el.empty();
    const { hints, normalized } = checkCouchUrl(this.couchUrl);
    for (const hint of hints) {
      el.createDiv({ cls: `vb-url-hint vb-lvl-${hint.level}`, text: hint.message });
    }
    // Nur melden, wenn die Normalisierung wirklich etwas ändert.
    if (normalized && normalized !== this.couchUrl) {
      el.createDiv({ cls: "vb-url-hint vb-lvl-ok", text: `Verwendet wird: ${normalized}` });
    }
  }

  /** Prüft Erreichbarkeit, Zugangsdaten und Datenbank, bevor der String entsteht. */
  private async runConnectionTest(resultEl: HTMLElement): Promise<void> {
    if (!this.couchUrl || !this.db || !this.user || !this.pass) {
      resultEl.setText("Bitte zuerst URL, Datenbank, Benutzer und Passwort ausfüllen.");
      return;
    }
    resultEl.setText("Test läuft …");
    const { normalized } = checkCouchUrl(this.couchUrl);
    const result = await testConnection({
      couchUrl: normalized || this.couchUrl,
      db: this.db,
      user: this.user,
      pass: this.pass,
    });
    resultEl.setText(`${result.ok ? "✅" : "❌"} ${result.message}`);
  }
```

Vor der „Erzeugen"-Schaltfläche einfügen:

```ts
    const testResultEl = contentEl.createDiv({ cls: "vb-url-hint" });
    new Setting(contentEl)
      .setName("Verbindung testen")
      .setDesc("Prüft Erreichbarkeit, Zugangsdaten und Datenbank — vor dem Erzeugen des Setup-Strings.")
      .addButton((b) =>
        b.setButtonText("Verbindung testen").onClick(() => void this.runConnectionTest(testResultEl)),
      );
```

- [ ] **Step 4: Normalisierte URL in den Setup-String schreiben**

In `generate()` das Payload-Feld ersetzen:

```ts
    const { normalized } = checkCouchUrl(this.couchUrl);
    const payload: SetupPayload = {
      v: 1,
      couchUrl: normalized || this.couchUrl,
```

- [ ] **Step 5: Stile ergänzen**

An `styles.css` anhängen:

```css
/* Hinweise zur CouchDB-URL im Generator */
.vb-url-hints { margin: -6px 0 10px; }
.vb-url-hint { font-size: 0.85em; line-height: 1.4; margin-top: 3px; }
.vb-url-hint.vb-lvl-ok { color: var(--text-muted); }
.vb-url-hint.vb-lvl-warn { color: var(--text-warning); }
.vb-url-hint.vb-lvl-error { color: var(--text-error); }
```

- [ ] **Step 6: Prüfen**

Run: `npx tsc --noEmit --skipLibCheck`, `npm run lint`, `npm test`
Expected: alle sauber

- [ ] **Step 7: Commit**

```bash
git add src/ui/GeneratorModal.ts styles.css
git commit -m "feat: Generator erklärt die URL-Schreibweise und testet die Verbindung sofort"
```

---

### Task 12: `fetch`-Adapter über `requestUrl`

**Files:**
- Create: `src/store/obsidianFetch.ts`
- Create: `test/obsidianFetch.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `RequestUrlLike` (Funktionstyp, kompatibel zu Obsidians `requestUrl`)
  - `makeRequestUrlFetch(request: RequestUrlLike): typeof fetch`
  — genutzt von Task 13

- [ ] **Step 1: Test schreiben**

`test/obsidianFetch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeRequestUrlFetch, RequestUrlLike } from "../src/store/obsidianFetch";

interface Captured {
  url: string; method: string; headers: Record<string, string>;
  body?: ArrayBuffer | string; throw: boolean;
}

function fakeRequest(
  reply: { status: number; headers?: Record<string, string>; body?: string },
  captured: Captured[] = [],
): { request: RequestUrlLike; captured: Captured[] } {
  const request: RequestUrlLike = (opts) => {
    captured.push(opts as Captured);
    const text = reply.body ?? "";
    return Promise.resolve({
      status: reply.status,
      headers: reply.headers ?? { "content-type": "application/json" },
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
      text,
    });
  };
  return { request, captured };
}

describe("makeRequestUrlFetch", () => {
  it("reicht URL, Methode und Header durch", async () => {
    const { request, captured } = fakeRequest({ status: 200, body: "{}" });
    const f = makeRequestUrlFetch(request);
    await f("http://host:5984/db/doc", { method: "PUT", headers: { Authorization: "Basic x" } });
    expect(captured[0].url).toBe("http://host:5984/db/doc");
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].headers.authorization).toBe("Basic x");
  });

  it("setzt throw:false, damit Fehlerstatus als Antwort ankommen", async () => {
    const { request, captured } = fakeRequest({ status: 404, body: '{"error":"not_found"}' });
    const f = makeRequestUrlFetch(request);
    const res = await f("http://host:5984/db/fehlt");
    expect(captured[0].throw).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("liefert eine auswertbare JSON-Antwort", async () => {
    const { request } = fakeRequest({ status: 200, body: '{"couchdb":"Welcome"}' });
    const res = await makeRequestUrlFetch(request)("http://host:5984/");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ couchdb: "Welcome" });
  });

  it("macht Header case-insensitiv lesbar", async () => {
    const { request } = fakeRequest({ status: 200, headers: { etag: '"3-abc"' }, body: "{}" });
    const res = await makeRequestUrlFetch(request)("http://host:5984/db/doc");
    expect(res.headers.get("ETag")).toBe('"3-abc"');
  });

  it("erzeugt für 304 eine Antwort ohne Rumpf", async () => {
    const { request } = fakeRequest({ status: 304 });
    const res = await makeRequestUrlFetch(request)("http://host:5984/db/doc");
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("überträgt einen String-Rumpf unverändert", async () => {
    const { request, captured } = fakeRequest({ status: 201, body: "{}" });
    await makeRequestUrlFetch(request)("http://host:5984/db", {
      method: "POST", body: '{"_id":"x"}',
    });
    expect(captured[0].body).toBe('{"_id":"x"}');
  });

  it("überträgt einen Binär-Rumpf als ArrayBuffer", async () => {
    const { request, captured } = fakeRequest({ status: 201, body: "{}" });
    const payload = new Uint8Array([1, 2, 3]);
    await makeRequestUrlFetch(request)("http://host:5984/db", { method: "POST", body: payload });
    expect(new Uint8Array(captured[0].body as ArrayBuffer)).toEqual(payload);
  });

  it("akzeptiert ein Request-artiges Objekt als erstes Argument", async () => {
    const { request, captured } = fakeRequest({ status: 200, body: "{}" });
    await makeRequestUrlFetch(request)(new URL("http://host:5984/db"));
    expect(captured[0].url).toBe("http://host:5984/db");
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run test/obsidianFetch.test.ts`
Expected: FAIL — `Cannot find module '../src/store/obsidianFetch'`

- [ ] **Step 3: Modul anlegen**

`src/store/obsidianFetch.ts`:

```ts
/**
 * Signatur von Obsidians `requestUrl`, auf das reduziert, was hier gebraucht
 * wird. Bewusst als Typ statt Import: so bleibt dieses Modul frei von
 * "obsidian" und damit unter vitest testbar. Die echte Funktion wird in
 * main.ts hereingereicht.
 */
export type RequestUrlLike = (opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
  throw: boolean;
  contentType?: string;
}) => Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}>;

// Statuscodes, bei denen der Response-Konstruktor keinen Rumpf akzeptiert.
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as { url: string }).url;
}

async function bodyOf(body: BodyInit | null | undefined): Promise<ArrayBuffer | string | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return await body.arrayBuffer();
  return String(body);
}

/**
 * Baut aus Obsidians `requestUrl` eine `fetch`-kompatible Funktion, die als
 * `{ fetch }`-Option an die Remote-PouchDB übergeben werden kann.
 *
 * Sinn: `requestUrl` läuft auf dem Desktop im Electron-Main-Prozess und auf
 * Mobil über die native Bridge — also außerhalb des Renderers. Damit greifen
 * weder CORS noch Chromiums Local Network Access, das seit Chrome 142
 * Zugriffe auf lokale Adressen sperrt und dafür keine Serverkonfiguration mehr
 * kennt.
 *
 * Grenzen, die den Einsatz als NICHT-Standard begründen: `requestUrl` puffert
 * die Antwort vollständig (kein Streaming) und kennt kein AbortSignal, ein
 * abgebrochener Live-Sync kann also noch bis zum Timeout offen bleiben. Für
 * PouchDB reicht es, weil dessen Live-Replikation `_changes?feed=longpoll`
 * benutzt und damit vollständige Antwortkörper erhält.
 */
export function makeRequestUrlFetch(request: RequestUrlLike): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = await bodyOf(init?.body);
    const res = await request({
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      // Fehlerstatus als Antwort, nicht als Ausnahme — PouchDB wertet
      // Statuscodes selbst aus (404 bedeutet dort z. B. "Dokument neu").
      throw: false,
    });
    return new Response(NO_BODY.has(res.status) ? null : res.arrayBuffer, {
      status: res.status,
      headers: res.headers,
    });
  };
  return impl as unknown as typeof fetch;
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/obsidianFetch.ts test/obsidianFetch.test.ts
git commit -m "feat: fetch-Adapter über requestUrl (umgeht CORS und Local Network Access)"
```

---

### Task 13: Verbindungsart, Selbsttest über beide Wege, Doku, Version

**Files:**
- Modify: `src/main.ts` (Settings, `connect`)
- Modify: `src/setup/connection.ts:7-13` (Kommentar)
- Modify: `src/setup/selfTest.ts`
- Modify: `src/ui/SettingsTab.ts` (Verbindungsart, Selbsttest-Ausgabe)
- Modify: `docs/server-setup.md`, `README.md`
- Modify: `manifest.json`, `package.json`, `versions.json`

**Interfaces:**
- Consumes: `makeRequestUrlFetch`/`RequestUrlLike` (Task 12), `checkCouchUrl` (Task 10)
- Produces: `VaultbridgeSettings.transport: "fetch" | "requestUrl"`

- [ ] **Step 1: Setting anlegen**

In `VaultbridgeSettings`:

```ts
  // Transportweg zur CouchDB. "fetch" (Standard) ist das Browser-fetch mit
  // Streaming — bewährt und unverändert. "requestUrl" leitet über Obsidians
  // eigene HTTP-Schicht um und umgeht damit CORS und Chromiums Local Network
  // Access; nötig, wenn die CouchDB auf einer lokalen Adresse läuft.
  transport: "fetch" | "requestUrl";
```

In `DEFAULT_SETTINGS`:

```ts
  transport: "fetch",
```

- [ ] **Step 2: Transport in `connect()` anwenden**

Import ergänzen (`requestUrl` in den bestehenden `obsidian`-Import aufnehmen):

```ts
import { EventRef, Menu, Notice, Platform, Plugin, TAbstractFile, requestUrl } from "obsidian";
import { makeRequestUrlFetch, RequestUrlLike } from "./store/obsidianFetch";
```

Die Remote-Erzeugung in `connect()` ersetzen:

```ts
      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, {
        auth: { username: payload.user, password: payload.pass },
        ...(this.settings.transport === "requestUrl"
          ? { fetch: makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike) }
          : {}),
      });
```

- [ ] **Step 3: Selbsttest über beide Wege**

`src/setup/selfTest.ts` — Ergebnistyp und Signatur erweitern:

```ts
export interface SelfTestResult {
  crypto: { ok: boolean; message: string };
  /** Browser-fetch — der Standardweg. */
  connection: ConnectionResult;
  /** Obsidians requestUrl — nur geprüft, wenn ein Adapter übergeben wurde. */
  connectionRequestUrl?: ConnectionResult;
}
```

Signatur und Abschluss der Funktion:

```ts
export async function runSelfTest(
  payload: SetupPayload,
  passphrase: string,
  // Standard bleibt das Browser-`fetch`: es übt exakt den Pfad aus, den PouchDB
  // im Normalbetrieb nimmt, inklusive CORS-Preflight. Wird zusätzlich ein
  // requestUrl-Adapter übergeben, wird der zweite Weg separat geprüft — so
  // sieht man auf einen Blick, ob ein Umstellen der Verbindungsart hilft.
  fetchFn: typeof fetch = fetch,
  requestUrlFetch?: typeof fetch,
): Promise<SelfTestResult> {
```

Am Ende der Funktion:

```ts
  const connection = await testConnection(payload, fetchFn);
  const connectionRequestUrl = requestUrlFetch
    ? await testConnection(payload, requestUrlFetch)
    : undefined;
  return { crypto: cryptoResult, connection, ...(connectionRequestUrl ? { connectionRequestUrl } : {}) };
}
```

In `src/setup/connection.ts` den Kommentarblock über `fetchFn` ersetzen:

```ts
  // Standard ist das Browser-`fetch`, weil es genau den Pfad prüft, den PouchDB
  // im Normalbetrieb nimmt — inklusive CORS-Preflight. Der Selbsttest ruft diese
  // Funktion zusätzlich mit dem requestUrl-Adapter auf, um beide Wege getrennt
  // auszuweisen. Den Default hier NICHT auf requestUrl umstellen: der umgeht
  // CORS und würde den Test fälschlich grün machen.
```

- [ ] **Step 4: Einstellung samt Hinweistext in den Settings-Tab**

In `src/ui/SettingsTab.ts` im Abschnitt „Synchronisierung", nach „Automatisch verbinden":

```ts
    new Setting(containerEl)
      .setName("Verbindungsart")
      .setDesc(
        "Wie Vaultbridge die CouchDB anspricht. „Browser\" ist der Standard und überträgt laufend " +
          "(Streaming). „Obsidian (requestUrl)\" leitet über Obsidians eigene HTTP-Schicht um.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ fetch: "Browser (Standard)", requestUrl: "Obsidian (requestUrl)" })
          .setValue(this.plugin.settings.transport)
          .onChange(async (value) => {
            this.plugin.settings.transport = value as "fetch" | "requestUrl";
            await this.plugin.saveSettings();
            new Notice("Vaultbridge: wirkt beim nächsten Verbinden.");
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Verbindung wird blockiert? Chrome 142 — die Grundlage aktueller Obsidian-Versionen — verlangt eine " +
        "Berechtigung, bevor eine App auf Adressen im lokalen Netz zugreifen darf (192.168.…, 10.…, localhost). " +
        "Obsidian hat für diese Abfrage keine Oberfläche, deshalb schlägt die Verbindung ohne Erklärung fehl. " +
        "Am Server lässt sich das nicht beheben: der früher übliche Header Access-Control-Allow-Private-Network " +
        "wird von Chrome 142 nicht mehr ausgewertet. Stell in diesem Fall die Verbindungsart auf " +
        "„Obsidian (requestUrl)\" — damit läuft der Sync an dieser Sperre vorbei. Der Selbsttest prüft beide Wege.",
    });
```

- [ ] **Step 5: Selbsttest-Ausgabe erweitern**

`runSelfTest` im Settings-Tab — Importe ergänzen:

```ts
import { requestUrl } from "obsidian";
import { makeRequestUrlFetch, RequestUrlLike } from "../store/obsidianFetch";
```

Aufruf und Ausgabe ersetzen:

```ts
    new Notice("Selbsttest läuft …");
    const result = await runSelfTest(
      payload,
      passphrase,
      fetch,
      makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike),
    );
    const icon = (ok: boolean): string => (ok ? "✅" : "❌");
    const lines = [
      `${icon(result.crypto.ok)} Verschlüsselung: ${result.crypto.message}`,
      `${icon(result.connection.ok)} Browser: ${result.connection.message}`,
    ];
    if (result.connectionRequestUrl) {
      lines.push(`${icon(result.connectionRequestUrl.ok)} Obsidian (requestUrl): ${result.connectionRequestUrl.message}`);
      if (!result.connection.ok && result.connectionRequestUrl.ok) {
        lines.push("→ Stell die Verbindungsart auf „Obsidian (requestUrl)\" um.");
      }
    }
    new Notice(lines.join("\n"), 15000);
```

- [ ] **Step 6: Dokumentation**

In `docs/server-setup.md` im Abschnitt „Troubleshooting" nach dem CORS-Punkt einfügen:

```markdown
- **Blocked on a local IP (Chrome 142+ / Local Network Access)** — if your CouchDB
  runs on `192.168.…`, `10.…` or `localhost`, recent Obsidian versions (Chromium 142
  and newer) require a user permission before any app may reach a local network
  address. Obsidian has no UI for that prompt, so the request fails silently. This
  **cannot be fixed on the server**: Local Network Access replaced the older
  Private Network Access model, and the `Access-Control-Allow-Private-Network`
  response header is no longer evaluated. In Vaultbridge's settings, switch
  **Connection method** to **Obsidian (requestUrl)** — that routes replication
  through Obsidian's own HTTP layer, which is subject to neither CORS nor Local
  Network Access. The built-in self-test checks both paths and tells you which one
  works.
```

In `README.md` unter den Anforderungen ergänzen:

```markdown
If your CouchDB lives on a local IP, recent Obsidian builds may block the connection
(Chromium's Local Network Access). Switch **Connection method** to **Obsidian
(requestUrl)** in the settings — see [`docs/server-setup.md`](docs/server-setup.md).
```

- [ ] **Step 7: Version auf 1.3.0**

- `manifest.json`: `"version": "1.3.0"`
- `package.json`: `"version": "1.3.0"`
- `versions.json`: Zeile `"1.3.0": "1.7.2"` ergänzen (minAppVersion unverändert)

- [ ] **Step 8: Vollständige Prüfung**

Run: `npm test`
Expected: PASS

Run: `npm run lint`
Expected: keine Errors

Run: `npm run build`
Expected: erfolgreich, inkl. `verify-pouch-bundle.mjs`

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/setup/connection.ts src/setup/selfTest.ts src/ui/SettingsTab.ts \
        docs/server-setup.md README.md manifest.json package.json versions.json
git commit -m "feat: umschaltbare Verbindungsart, Selbsttest über beide Wege, v1.3.0"
```

---

## Manuelle Abnahme

Nach Task 13 im echten Obsidian prüfen — diese Fälle deckt keine Testdatei ab:

- [ ] **Neues Gerät:** Vault auf ein zweites Gerät kopieren, Setup-String eintragen, verbinden. Statusleiste zeigt „Erstabgleich …", danach **null** Konflikte.
- [ ] **Konflikt mit Gerätezuordnung:** Auf zwei Geräten offline dieselbe Notiz unterschiedlich ändern, beide verbinden. Meldung nennt Datei und beide Gerätenamen, `<datei>.vaultbridge-konflikt` liegt im Vault, die neuere Fassung ist aktiv.
- [ ] **Vergleichsansicht:** Konflikt manuell offen lassen (Auflösung über den Befehl verzögern) und prüfen, dass Kopfzeile, Spaltenköpfe und Binär-Karten Gerät und Zeit anzeigen.
- [ ] **Offline-Start:** Obsidian ohne Netz starten, Notiz ändern, dann Netz einschalten. Nach dem ersten Settle ist die Änderung oben und es gibt keinen Konflikt.
- [ ] **MacBook / Local Network Access:** Selbsttest gegen die CouchDB auf lokaler IP. Erwartet: Browser ❌, Obsidian (requestUrl) ✅ samt Umstellungshinweis. Nach dem Umstellen läuft der Sync durch.
- [ ] **URL-Hilfe:** Im Generator nacheinander `192.168.20.30:5984`, `http://host:5984/vault`, `http://host:5984/_utils` und `http://192.168.20.30:5984` eintippen und die Hinweise gegenlesen.
