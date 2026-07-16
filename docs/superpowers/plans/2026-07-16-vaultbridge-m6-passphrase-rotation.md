# Vaultbridge — Meilenstein 6: Passphrase-Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Dies ist das höchste Einzelrisiko in v1 — gründliche Tests, sorgfältige Reviews.

**Goal:** Die Vault-Passphrase ändern: alle aktuellen Dateien mit dem neuen Schlüssel neu verschlüsseln (abbrechbar/fortsetzbar), andere Geräte erkennen die Rotation automatisch über ein Marker-Dokument und übernehmen die neue Passphrase.

**Architecture (Nutzerwahl: einfaches Modell):** Rotation verschlüsselt nur die **aktuellen** Versionen neu; Verlauf vor der Rotation wird unlesbar (Compaction räumt ihn weg). Da die Note-`_id` = HMAC(Pfad) vom Passphrase-abgeleiteten `idKey` stammt, ändert sich die id bei Rotation — Rotation legt daher jede Datei mit dem neuen Schlüssel unter neuer id an und **entfernt** das alte Doc. Ein **Zwei-Schlüssel-Ring** (aktuell + vorherig) erlaubt das Lesen alt-verschlüsselter Docs während der Übergangsphase (nach id). `getFile(path)` löst immer auf die aktuelle id auf. Ein synchronisiertes **Marker-Doc** (`vaultbridge:epoch`) trägt Salt/Epoche/Verifikations-Token; andere Geräte erkennen die neue Epoche, fragen nach der neuen Passphrase, verifizieren gegen den Token und übernehmen.

**Tech Stack:** TypeScript, esbuild, Vitest, PouchDB, WebCrypto, Obsidian API.

## Global Constraints

- Baut auf bestehenden Signaturen: `VaultKeys`, `deriveKeys`, `encryptBytes`/`decryptBytes` (`crypto/crypto`); `encodeFile`/`decodeFile` (`store/transform`); `VaultStore` (`putFile/getFile/readNote/readNoteRev/getConflict/listRevisions/pathHashes/subscribe`, privat `db`/`keys`/`writeChunks`); `SetupPayload`/`encodeSetup`/`decodeSetup`.
- Rotation ist **abbrechbar** (AbortSignal) und **idempotent/fortsetzbar** (erneutes `rotate()` schließt eine abgebrochene Rotation ab: es verschlüsselt jede noch alt-verschlüsselte aktuelle Note neu).
- **Kein Datenverlust bei aktuellen Dateien:** eine Note wird erst nach erfolgreichem Neu-Schreiben (neue id) entfernt (alte id). Bei Abbruch koexistieren alt+neu — der Schlüssel-Ring liest beide.
- Verifikation vor Rotation: die eingegebene alte Passphrase muss die aktuellen Daten entschlüsseln.
- Marker-Doc `vaultbridge:epoch` ist kein `n:`/`h:`-Doc → von Bridge/Reconcile ignoriert, repliziert aber.
- Nur Web-/Obsidian-/PouchDB-APIs in `src/`. Deutsche UI-Strings. TS-5.9-`asBuffer`-Muster bei WebCrypto.
- TDD, häufige Commits, DRY, YAGNI. Arbeitsverzeichnis: `23 obsidian-sync/vaultbridge/`.

---

## Dateistruktur (Meilenstein 6)

```
src/store/store.ts       # erweitert: previousKeys + tryDecode (Ring), rotate(), Marker-Zugriff
src/crypto/rotation.ts   # Marker-Schema + reine Adoptions-Entscheidung + Verifikations-Token
src/ui/RotationModal.ts  # "Passphrase ändern": alt/neu, Verifikation, Fortschritt
src/main.ts              # Wiring: Befehl, Marker-Erkennung + Adoptions-Prompt
test/keyring.test.ts   test/rotation.test.ts   test/rotationMarker.test.ts
test/rotationIntegration.test.ts
```

---

## Task 1: Store — Zwei-Schlüssel-Ring (Lesen alt-verschlüsselter Docs)

**Files:** Modify `src/store/store.ts`; Test `test/keyring.test.ts`

**Interfaces:**
- Produces:
  - Konstruktor akzeptiert optional `previousKeys` (4. Parameter) ODER eine Methode `setKeys(current: VaultKeys, previous?: VaultKeys | null): void`.
  - Alle **id-basierten** Decode-Stellen (`readNote`, `readNoteRev`, `getConflict`, `pathHashes`) versuchen zuerst `keys`, dann `previousKeys`. `getFile(path)`/`putFile` nutzen weiter nur `keys` (die aktuelle id).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/keyring.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

describe("Zwei-Schlüssel-Ring", () => {
  it("liest ein mit dem vorherigen Schlüssel geschriebenes Doc nach id", async () => {
    const kA = await deriveKeys("altA", new Uint8Array(16).fill(1), 50000);
    const kB = await deriveKeys("neuB", new Uint8Array(16).fill(2), 50000);
    const db = createTestPouch();
    const storeA = new VaultStore(db, kA, 4);
    await storeA.putFile("x.md", utf8.encode("geheim"), meta);
    const idA = await pathId(kA.idKey, "x.md");

    // Store mit aktuellem kB, vorherigem kA -> readNoteRev/getConflict nach idA lesen kA-Docs
    const storeB = new VaultStore(db, kB, 4, kA);
    // aktuelle Revision von idA lesen:
    const revs = await storeB.listRevisions(idA);
    expect(revs.length).toBeGreaterThanOrEqual(1);
    expect(utf8.decode(revs[0].bytes)).toBe("geheim"); // via vorherigem Schlüssel
  });

  it("ohne vorherigen Schlüssel scheitert das Entschlüsseln kontrolliert (null/leer)", async () => {
    const kA = await deriveKeys("altA", new Uint8Array(16).fill(1), 50000);
    const kB = await deriveKeys("neuB", new Uint8Array(16).fill(2), 50000);
    const db = createTestPouch();
    await new VaultStore(db, kA, 4).putFile("x.md", utf8.encode("geheim"), meta);
    const idA = await pathId(kA.idKey, "x.md");
    const storeB = new VaultStore(db, kB, 4); // kein previous
    expect(await storeB.listRevisions(idA)).toEqual([]); // nicht entschlüsselbar -> übersprungen
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/keyring.test.ts`

- [ ] **Step 3: Ring in `src/store/store.ts` implementieren**
  - Konstruktor: `constructor(private db, private keys, private chunkSize, private previousKeys: VaultKeys | null = null)`.
  - Methode `setKeys(current: VaultKeys, previous: VaultKeys | null = null): void { this.keys = current; this.previousKeys = previous; }`
  - Privates `tryDecode(note: NoteDoc): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null>`:
    ```ts
    private async tryDecode(note: NoteDoc) {
      const candidates = this.previousKeys ? [this.keys, this.previousKeys] : [this.keys];
      for (const k of candidates) {
        try {
          return await decodeFile(k, note, (cid) => this.db.get<ChunkDoc>(cid));
        } catch { /* falscher Schlüssel oder fehlender Chunk -> nächster */ }
      }
      return null;
    }
    ```
  - `readNoteRev`: nach `db.get(id,{rev})` `return this.tryDecode(note)` (statt `decodeFile(this.keys, ...)`).
  - `getConflict`: winning-Decode und jede losing-Revision über `readNoteRev`/`tryDecode`.
  - `pathHashes`: pro Doc `tryDecode`; wenn null → überspringen.
  - `getFile`/`putFile` bleiben unverändert (nur `this.keys`).

- [ ] **Step 4: Test ausführen → PASS (2 Tests)** — Run: `npx vitest run test/keyring.test.ts`; danach **volle Suite** `npm test` (alle bestehenden Tests grün — die Konstruktor-Erweiterung ist rückwärtskompatibel per Default `null`).

- [ ] **Step 5: Commit** — `git add src/store/store.ts test/keyring.test.ts && git commit -m "feat(store): Zwei-Schlüssel-Ring (liest alt-verschlüsselte Docs während Rotation)"`

---

## Task 2: Rotations-Engine

**Files:** Modify `src/store/store.ts`; Test `test/rotation.test.ts`

**Interfaces:**
- Produces: `rotate(newKeys: VaultKeys, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<void>` auf `VaultStore`.
  - Zählt aktuelle Notes; für jede: mit dem AKTUELLEN Schlüssel (Ring) entschlüsseln; wenn schon mit `newKeys` lesbar → überspringen (idempotent/fortsetzbar); sonst mit `newKeys` neu kodieren (neue id + neue Chunks), schreiben, das alte Doc entfernen. Danach `setKeys(newKeys, oldKeys)`.
  - Bei `signal.aborted` wirft es `"Rotation abgebrochen"` — bereits rotierte Dateien bleiben (Ring liest den Rest weiter).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/rotation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

describe("rotate", () => {
  it("verschlüsselt aktuelle Dateien mit dem neuen Schlüssel neu (mit neuem Schlüssel lesbar)", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    await store.putFile("b.md", utf8.encode("Beta"), meta);

    let seen = 0;
    await store.rotate(kNew, (d) => { seen = d; });
    expect(seen).toBe(2);

    // Store nach Rotation nutzt kNew -> Dateien lesbar
    expect(utf8.decode((await store.getFile("a.md"))!.bytes)).toBe("Alpha");
    expect(utf8.decode((await store.getFile("b.md"))!.bytes)).toBe("Beta");
  });

  it("ist idempotent/fortsetzbar (erneutes rotate ändert nichts mehr)", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    await store.rotate(kNew);
    let seen2 = -1;
    await store.rotate(kNew, (d, t) => { seen2 = t; });
    // alle bereits kNew-lesbar -> nichts neu zu rotieren, getFile bleibt korrekt
    expect(utf8.decode((await store.getFile("a.md"))!.bytes)).toBe("Alpha");
  });

  it("bricht bei signal.aborted ab", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(store.rotate(kNew, undefined, ctrl.signal)).rejects.toThrow(/abgebrochen/);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/rotation.test.ts`

- [ ] **Step 3: `rotate` in `src/store/store.ts` implementieren**
```ts
  async rotate(
    newKeys: VaultKeys,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.db.allDocs<NoteDoc>({ startkey: "n:", endkey: "n:￰", include_docs: true });
    const notes = res.rows
      .map((r) => r.doc)
      .filter((d): d is NoteDoc & { _rev: string } => !!d && d.type === "note" && !d.deleted);
    const total = notes.length;
    let done = 0;
    for (const note of notes) {
      if (signal?.aborted) throw new Error("Rotation abgebrochen");
      // Schon mit dem neuen Schlüssel lesbar? -> überspringen (idempotent)
      let alreadyNew = false;
      try { await decodeFile(newKeys, note, (cid) => this.db.get<ChunkDoc>(cid)); alreadyNew = true; } catch { /* nein */ }
      if (!alreadyNew) {
        const decoded = await this.tryDecode(note);
        if (decoded) {
          const { note: newNote, chunks } = await encodeFile(newKeys, decoded.path, decoded.bytes, decoded.meta, this.chunkSize);
          await this.writeChunks(chunks);
          const prev = await this.getRaw<NoteDoc>(newNote._id);
          if (prev) newNote._rev = prev._rev;
          await this.db.put(newNote);
          if (newNote._id !== note._id) {
            try { await this.db.remove(note._id, note._rev); } catch { /* schon weg */ }
          }
        }
      }
      done++;
      onProgress?.(done, total);
    }
    const old = this.keys;
    this.setKeys(newKeys, old);
  }
```

- [ ] **Step 4: Test ausführen → PASS (3 Tests)** — Run: `npx vitest run test/rotation.test.ts`; danach volle Suite `npm test`.

- [ ] **Step 5: Commit** — `git add src/store/store.ts test/rotation.test.ts && git commit -m "feat(store): Rotations-Engine (aktuelle Dateien neu verschlüsseln, idempotent/abbrechbar)"`

---

## Task 3: Epoch-Marker + Adoptions-Logik

**Files:** Create `src/crypto/rotation.ts`; Modify `src/store/store.ts` (Marker lesen/schreiben); Test `test/rotationMarker.test.ts`

**Interfaces:**
- `rotation.ts` (rein):
  - `interface EpochMarker { epoch: number; kdfSalt: string; kdfIter: number; verify: string }`
  - `const MARKER_ID = "vaultbridge:epoch"`
  - `makeVerifyToken(keys: VaultKeys, epoch: number): Promise<string>` (= base64url(encryptBytes(contentKey, utf8("vaultbridge-epoch-"+epoch))))
  - `checkVerifyToken(keys: VaultKeys, epoch: number, token: string): Promise<boolean>` (entschlüsselt + vergleicht)
  - `needsAdoption(localEpoch: number, marker: EpochMarker | null): boolean` (= marker != null && marker.epoch > localEpoch)
- `store.ts`:
  - `readEpochMarker(): Promise<EpochMarker | null>` (`db.get(MARKER_ID)` oder null)
  - `writeEpochMarker(marker: EpochMarker): Promise<void>` (put mit vorhandener `_rev`)

- [ ] **Step 1: Fehlschlagende Tests schreiben**

`test/rotationMarker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "../src/crypto/rotation";

describe("Epoch-Marker", () => {
  it("Verifikations-Token: korrekter Schlüssel akzeptiert, falscher lehnt ab", async () => {
    const k1 = await deriveKeys("p1", new Uint8Array(16).fill(1), 50000);
    const k2 = await deriveKeys("p2", new Uint8Array(16).fill(2), 50000);
    const token = await makeVerifyToken(k1, 2);
    expect(await checkVerifyToken(k1, 2, token)).toBe(true);
    expect(await checkVerifyToken(k2, 2, token)).toBe(false);
    expect(await checkVerifyToken(k1, 3, token)).toBe(false); // falsche Epoche
  });
  it("needsAdoption bei höherer Marker-Epoche", () => {
    expect(needsAdoption(1, { epoch: 2, kdfSalt: "s", kdfIter: 1, verify: "v" })).toBe(true);
    expect(needsAdoption(2, { epoch: 2, kdfSalt: "s", kdfIter: 1, verify: "v" })).toBe(false);
    expect(needsAdoption(1, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/rotationMarker.test.ts`

- [ ] **Step 3: `src/crypto/rotation.ts` implementieren**
```ts
import { VaultKeys, encryptBytes, decryptBytes } from "./crypto";
import { utf8, bytesToBase64url, base64urlToBytes } from "./encoding";

export const MARKER_ID = "vaultbridge:epoch";

export interface EpochMarker {
  epoch: number;
  kdfSalt: string;
  kdfIter: number;
  verify: string;
}

function tokenPlain(epoch: number): Uint8Array {
  return utf8.encode("vaultbridge-epoch-" + epoch);
}

export async function makeVerifyToken(keys: VaultKeys, epoch: number): Promise<string> {
  return bytesToBase64url(await encryptBytes(keys.contentKey, tokenPlain(epoch)));
}

export async function checkVerifyToken(keys: VaultKeys, epoch: number, token: string): Promise<boolean> {
  try {
    const plain = await decryptBytes(keys.contentKey, base64urlToBytes(token));
    return utf8.decode(plain) === "vaultbridge-epoch-" + epoch;
  } catch {
    return false;
  }
}

export function needsAdoption(localEpoch: number, marker: EpochMarker | null): boolean {
  return marker !== null && marker.epoch > localEpoch;
}
```
Und in `store.ts` `readEpochMarker`/`writeEpochMarker` (mit `import { MARKER_ID, EpochMarker } from "../crypto/rotation";`):
```ts
  async readEpochMarker(): Promise<EpochMarker | null> {
    try { return (await this.db.get(MARKER_ID)) as unknown as EpochMarker; } catch { return null; }
  }
  async writeEpochMarker(marker: EpochMarker): Promise<void> {
    let rev: string | undefined;
    try { rev = ((await this.db.get(MARKER_ID)) as { _rev: string })._rev; } catch { /* neu */ }
    await this.db.put({ _id: MARKER_ID, ...(rev ? { _rev: rev } : {}), ...marker });
  }
```

- [ ] **Step 4: Test ausführen → PASS (2 Tests)** — Run: `npx vitest run test/rotationMarker.test.ts`; volle Suite.

- [ ] **Step 5: Commit** — `git add src/crypto/rotation.ts src/store/store.ts test/rotationMarker.test.ts && git commit -m "feat(crypto): Epoch-Marker + Verifikations-Token + Adoptions-Entscheidung"`

---

## Task 4: UI (Passphrase ändern) + Adoptions-Verdrahtung

**Files:** Create `src/ui/RotationModal.ts`; Modify `src/main.ts`, `src/ui/SettingsTab.ts`. Manuell verifiziert.

- [ ] **Step 1: `RotationModal.ts`** — Modal „Passphrase ändern": Felder alte Passphrase, neue Passphrase, neue Passphrase (Wiederholung). Beim Bestätigen:
  1. Alte Passphrase verifizieren: `deriveKeys(alt, currentSalt, iter)` und einen Selbsttest/Decode einer bekannten Datei prüfen (oder gegen die aktuellen `keys` vergleichen, indem ein Probe-Roundtrip gelingt). Bei Fehlschlag Notice, abbrechen.
  2. Neu==Wiederholung prüfen.
  3. Neues Salt (16 Zufallsbytes), `newKeys = deriveKeys(neu, newSalt, iter)`.
  4. `store.rotate(newKeys, onProgress)` mit Fortschrittsanzeige (`done/total`), AbortController-Button „Abbrechen".
  5. Marker schreiben: `epoch = (aktuelleEpoche)+1`, `kdfSalt=newSalt`, `kdfIter`, `verify=makeVerifyToken(newKeys, epoch)` → `store.writeEpochMarker(...)`.
  6. Lokale Config aktualisieren: Salt/Epoche in den Plugin-Settings; bei eingebettetem Modus einen NEUEN Setup-String erzeugen und anzeigen („an andere Geräte verteilen"), sonst Hinweis, dass andere Geräte nach der neuen Passphrase gefragt werden.
  7. `main.ts`-Sync-Stack auf `newKeys` umstellen (das Feld `keysForHistory` etc.), Notice „Passphrase geändert".

- [ ] **Step 2: `main.ts` — Adoptions-Prüfung** — beim Verbinden und bei jedem Sync-Settle `store.readEpochMarker()` prüfen; wenn `needsAdoption(localEpoch, marker)`:
  - Notice „Die Passphrase wurde auf einem anderen Gerät geändert." + Prompt (via `promptPassphrase`) nach der neuen Passphrase.
  - `candidate = deriveKeys(eingegeben, marker.kdfSalt, marker.kdfIter)`; `checkVerifyToken(candidate, marker.epoch, marker.verify)` → bei ok: `store.setKeys(candidate, altenKeys)`, lokale Epoche/Salt speichern, Notice „Neue Passphrase übernommen"; sonst Notice „Passphrase falsch".
  - Verfolge die lokale Epoche in den Settings (`epoch: number`, Default 0).

- [ ] **Step 3: `SettingsTab.ts`** — Button „Passphrase ändern" öffnet `RotationModal`.

- [ ] **Step 4: Build + volle Suite** — `npm run build && npm test`.

- [ ] **Step 5: Manuelle Verifikation (pending human)** — auf Gerät A Passphrase ändern (Fortschritt läuft), Dateien bleiben lesbar; auf Gerät B erscheint der Adoptions-Prompt, nach Eingabe der neuen Passphrase sind die Dateien wieder lesbar.

- [ ] **Step 6: Commit** — `git add src/ui/RotationModal.ts src/main.ts src/ui/SettingsTab.ts && git commit -m "feat(ui): Passphrase-Rotation (Modal + Fortschritt) + automatische Adoption über Epoch-Marker"`

---

## Task 5: Integrationstest — Zwei-Geräte-Rotation

**Files:** Create `test/rotationIntegration.test.ts`

- [ ] **Step 1: Integrationstest schreiben**

`test/rotationIntegration.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "../src/crypto/rotation";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };
function syncOnce(a: PouchDB.Database, b: PouchDB.Database) {
  return new Promise<void>((res, rej) => a.sync(b).on("complete", () => res()).on("error", rej));
}

describe("Integration: Zwei-Geräte-Rotation", () => {
  it("Gerät A rotiert; Gerät B übernimmt die neue Passphrase und liest die Dateien", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const newSalt = new Uint8Array(16).fill(2);
    const kNew = await deriveKeys("neu", newSalt, 50000);

    const dbA = createTestPouch();
    const dbB = createTestPouch();
    const a = new VaultStore(dbA, kOld, 64);
    const b = new VaultStore(dbB, kOld, 64);

    await a.putFile("Geheim.md", utf8.encode("Inhalt"), meta);
    await syncOnce(dbA, dbB);
    expect(utf8.decode((await b.getFile("Geheim.md"))!.bytes)).toBe("Inhalt");

    // A rotiert + schreibt Marker
    await a.rotate(kNew);
    const token = await makeVerifyToken(kNew, 1);
    await a.writeEpochMarker({ epoch: 1, kdfSalt: "salt", kdfIter: 50000, verify: token });
    await syncOnce(dbA, dbB);

    // B: Adoption erkennen + verifizieren + übernehmen
    const marker = await b.readEpochMarker();
    expect(needsAdoption(0, marker)).toBe(true);
    expect(await checkVerifyToken(kNew, marker!.epoch, marker!.verify)).toBe(true);
    b.setKeys(kNew, kOld);

    // B liest die (mit neuem Schlüssel, neuer id) rotierte Datei
    expect(utf8.decode((await b.getFile("Geheim.md"))!.bytes)).toBe("Inhalt");
    await dbA.destroy();
    await dbB.destroy();
  });
});
```

- [ ] **Step 2: Test ausführen → PASS** — Run: `npx vitest run test/rotationIntegration.test.ts`

- [ ] **Step 3: Volle Suite + Build** — `npm test && npm run build`.

- [ ] **Step 4: Commit** — `git add test/rotationIntegration.test.ts && git commit -m "test: Integrationstest — Zwei-Geräte-Passphrase-Rotation + Adoption"`

---

## Meilenstein-6-Abschluss

Danach: Passphrase-Rotation im einfachen Modell — aktuelle Dateien werden neu verschlüsselt (abbrechbar/fortsetzbar), ein Zwei-Schlüssel-Ring überbrückt die Übergangsphase, ein Marker-Doc lässt andere Geräte die Rotation automatisch erkennen und (nach Passphrase-Eingabe + Token-Verifikation) übernehmen. Store-/Krypto-Logik headless getestet, die UI manuell zu verifizieren.

**Bekannte Grenzen (Nutzerwahl „einfach"):** Verlauf VOR einer Rotation wird unlesbar (Compaction räumt ihn weg). Waisen-Chunks der alten Epoche bleiben bis zur Compaction liegen. Neu hinzukommende Geräte nach einer Rotation haben keinen Vor-Rotations-Verlauf.

**Manuelle Verifikation offen:** Rotation zwischen zwei verbundenen Obsidian-Instanzen gegen echte CouchDB.

**Danach:** M7 — Release-Reife (GitHub-Actions-Release, englische README, `docs/server-setup.md` mit Docker+CORS/Cloudant, LICENSE, Community-Einreichungs-PR gegen `obsidianmd/obsidian-releases`).
```
