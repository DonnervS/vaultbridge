# Vaultbridge — Meilenstein 4: Dateisteuerung, Plugin-Sync, Mobile, QR, Setup-Generator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Steuerbarer Sync von Fremd-/versteckten Dateien (`.claude/`, `.obsidian/`) über einen Regel-Editor; geräteübergreifender Plugin-Sync inkl. Aktualisierung; Mobile-Sync-Modi; QR-Onboarding und ein In-App-Setup-Generator.

**Architecture:** Auf M2/M3. Eine reine **Regel-Engine** (`vault/rules.ts`) entscheidet pro Pfad, ob synchronisiert wird. Da Obsidian für Dotfiles **keine** Vault-Events feuert, kommt ein **adapter-basierter periodischer Abgleich** (`vault/adapterScan.ts` + `vault/hiddenSync.ts`, reine Planungslogik + dünne I/O) hinzu; die Brücke wird um Regel-Gating und Hidden-File-Anwendung (via `vault.adapter`) erweitert. Plugin-Sync ist Dateisteuerung mit kuratierten Defaults plus einem Reload-Flow. Mobile-Modi steuern die Replikation. Generator + QR runden das Onboarding ab.

**Tech Stack:** TypeScript, esbuild, Vitest, PouchDB, `diff`, `qrcode`, Obsidian API.

## Global Constraints

- Baut auf M2/M3 mit deren exakten Signaturen (nicht ändern): `VaultStore` (`putFile/getFile/deleteFile/listConflicts/readNote/readNoteRev/getConflict/resolveConflict/subscribe`), `VaultBridge`, `EchoGuard`/`contentHash`/`decideVaultAction`, `startSync`/`SyncStatus`, `encodeSetup`/`SetupPayload` (`setup/setupString`), `deriveKeys`.
- **Plugin-Sync = alles spiegeln**: Plugin-Code + `.obsidian/community-plugins.json` (Aktiv-Status) + `data.json` (Einstellungen). Einstellungs-Konflikte landen in der M3-Diff-UI.
- **HARTE Ausnahme (nie synchronisieren, nicht abschaltbar):** Vaultbridge' eigenes Verzeichnis `.obsidian/plugins/vaultbridge/**` inkl. dessen `data.json` (Setup-String/Gerätename bleiben lokal — Bootstrap & Geräte-Identität).
- **Plugin-Update wirksam** via Hinweis + Neu-laden-Button (`app.plugins.disablePlugin`/`enablePlugin`), nie automatischer Selbst-Reload von Vaultbridge.
- Dotfiles (Segment beginnt mit `.`) werden nur synchronisiert, wenn `syncHidden` an ist UND ein Include-Glob passt. Normale Dateien synchronisieren standardmäßig, außer Exclude trifft zu.
- Hidden-File-Anwendung/-Schreiben über `vault.adapter` (nicht `vault.create*`, das ist für indizierte Dateien).
- Nur Web-APIs + Obsidian-API + PouchDB + `diff` + `qrcode` in `src/`. Deutsche UI-Strings.
- Reine Logik (Regeln, Scan-Planung, Modi, Reload-Planung) ist **headless testbar**; Obsidian-gekoppelte Teile manuell verifizieren.
- TDD, häufige Commits, DRY, YAGNI. Arbeitsverzeichnis: `23 obsidian-sync/vaultbridge/`.

---

## Dateistruktur (Meilenstein 4)

```
src/vault/
  rules.ts          # SyncRules, shouldSync, Defaults, Glob-Match (rein)
  adapterScan.ts    # listAllFiles(adapter) rekursiv (dünne I/O, testbar mit Fake)
  hiddenSync.ts     # planHiddenSync(local, known, store) -> {uploads, deleteRemotes} (rein)
  bridge.ts         # erweitert: Regel-Gating + Hidden-Reconcile + adapter-Anwendung
src/plugins/
  pluginSync.ts     # planPluginReload(changedPaths) -> pluginIds (rein) + Reload-Flow
src/store/
  syncModes.ts      # SyncMode-Typ + shouldReplicate(mode, ctx) (rein)
src/ui/
  SettingsTab.ts    # erweitert: Regel-Editor, Sync-Modus, Toggles
  GeneratorModal.ts # Setup-Generator (Formular -> encodeSetup) + QR + Kopieren
src/main.ts         # erweitert: Modi, Hidden-Reconcile-Loop, Plugin-Reload-Notice, Generator-Command
test/
  rules.test.ts  adapterScan.test.ts  hiddenSync.test.ts
  pluginSync.test.ts  syncModes.test.ts
```

---

## Task 1: Regel-Engine

**Files:** Create `src/vault/rules.ts`, `test/rules.test.ts`

**Interfaces:**
- Produces:
  - `interface SyncRules { syncHidden: boolean; include: string[]; exclude: string[] }`
  - `const DEFAULT_RULES: SyncRules`
  - `shouldSync(path: string, rules: SyncRules): boolean`
  - `isHidden(path: string): boolean`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/rules.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldSync, isHidden, DEFAULT_RULES, SyncRules } from "../src/vault/rules";

const rules: SyncRules = {
  syncHidden: true,
  include: [".claude/**", ".obsidian/plugins/**", ".obsidian/community-plugins.json"],
  exclude: [".obsidian/workspace*.json", ".trash/**"],
};

describe("rules", () => {
  it("normale Dateien werden standardmäßig synchronisiert", () => {
    expect(shouldSync("Notiz.md", rules)).toBe(true);
    expect(shouldSync("Ordner/Unter/x.md", rules)).toBe(true);
  });
  it("Exclude gewinnt", () => {
    expect(shouldSync(".obsidian/workspace.json", rules)).toBe(false);
    expect(shouldSync(".trash/x.md", rules)).toBe(false);
  });
  it("versteckte Dateien nur bei syncHidden UND passendem Include", () => {
    expect(shouldSync(".claude/config.md", rules)).toBe(true);
    expect(shouldSync(".obsidian/plugins/foo/main.js", rules)).toBe(true);
    expect(shouldSync(".obsidian/appearance.json", rules)).toBe(false); // kein Include
    expect(shouldSync(".claude/config.md", { ...rules, syncHidden: false })).toBe(false);
  });
  it("Vaultbridge' eigenes Verzeichnis wird NIE synchronisiert (harte Ausnahme)", () => {
    const permissive: SyncRules = { syncHidden: true, include: [".obsidian/plugins/**"], exclude: [] };
    expect(shouldSync(".obsidian/plugins/vaultbridge/main.js", permissive)).toBe(false);
    expect(shouldSync(".obsidian/plugins/vaultbridge/data.json", permissive)).toBe(false);
  });
  it("isHidden erkennt Dotfile-Segmente", () => {
    expect(isHidden(".claude/x")).toBe(true);
    expect(isHidden("a/.git/config")).toBe(true);
    expect(isHidden("normal/datei.md")).toBe(false);
  });
  it("DEFAULT_RULES schließt Vaultbridge-Self und Churn-Dateien aus, erlaubt .claude/plugins", () => {
    expect(shouldSync(".obsidian/plugins/andere/main.js", DEFAULT_RULES)).toBe(true);
    expect(shouldSync(".obsidian/plugins/vaultbridge/main.js", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".obsidian/workspace.json", DEFAULT_RULES)).toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/rules.test.ts`

- [ ] **Step 3: `src/vault/rules.ts` implementieren**

```ts
export interface SyncRules {
  syncHidden: boolean;
  include: string[];
  exclude: string[];
}

// Nie synchronisieren (nicht abschaltbar): Vaultbridge' eigenes Verzeichnis.
const HARD_EXCLUDE = [".obsidian/plugins/vaultbridge/**"];

export const DEFAULT_RULES: SyncRules = {
  syncHidden: true,
  include: [
    ".claude/**",
    ".obsidian/plugins/**",
    ".obsidian/snippets/**",
    ".obsidian/themes/**",
    ".obsidian/community-plugins.json",
    ".obsidian/appearance.json",
    ".obsidian/hotkeys.json",
  ],
  exclude: [
    ".obsidian/workspace*.json",
    ".obsidian/graph.json",
    ".trash/**",
    ".git/**",
    "node_modules/**",
    ".DS_Store",
  ],
};

export function isHidden(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}

export function shouldSync(path: string, rules: SyncRules): boolean {
  if (matchesAny(path, HARD_EXCLUDE)) return false;
  if (matchesAny(path, rules.exclude)) return false;
  if (isHidden(path)) {
    return rules.syncHidden && matchesAny(path, rules.include);
  }
  return true;
}
```

- [ ] **Step 4: Test ausführen → PASS (6 Tests)** — Run: `npx vitest run test/rules.test.ts`

- [ ] **Step 5: Commit** — `git add src/vault/rules.ts test/rules.test.ts && git commit -m "feat(vault): Regel-Engine (Include/Exclude-Globs, Hidden-Gating, harte Vaultbridge-Ausnahme)"`

---

## Task 2: Adapter-Scan (rekursive Dateiliste inkl. Dotfiles)

**Files:** Create `src/vault/adapterScan.ts`, `test/adapterScan.test.ts`

**Interfaces:**
- Produces: `interface ListingAdapter { list(path: string): Promise<{ files: string[]; folders: string[] }> }`; `listAllFiles(adapter: ListingAdapter, root?: string): Promise<string[]>` (alle Dateipfade rekursiv, inkl. versteckter).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/adapterScan.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { listAllFiles, ListingAdapter } from "../src/vault/adapterScan";

function fakeAdapter(tree: Record<string, { files: string[]; folders: string[] }>): ListingAdapter {
  return { list: async (p) => tree[p] ?? { files: [], folders: [] } };
}

describe("listAllFiles", () => {
  it("listet Dateien rekursiv inkl. versteckter Ordner", async () => {
    const adapter = fakeAdapter({
      "": { files: ["a.md"], folders: [".claude", "Ordner"] },
      ".claude": { files: [".claude/config.md"], folders: [] },
      "Ordner": { files: ["Ordner/b.md"], folders: [] },
    });
    const files = await listAllFiles(adapter, "");
    expect(files.sort()).toEqual(["Ordner/b.md", ".claude/config.md", "a.md"].sort());
  });

  it("leerer Baum ergibt leere Liste", async () => {
    expect(await listAllFiles(fakeAdapter({}), "")).toEqual([]);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/adapterScan.test.ts`

- [ ] **Step 3: Implementieren**

`src/vault/adapterScan.ts`:
```ts
export interface ListingAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export async function listAllFiles(adapter: ListingAdapter, root = ""): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const { files, folders } = await adapter.list(dir);
    out.push(...files);
    stack.push(...folders);
  }
  return out;
}
```

- [ ] **Step 4: Test ausführen → PASS (2 Tests)** — Run: `npx vitest run test/adapterScan.test.ts`

- [ ] **Step 5: Commit** — `git add src/vault/adapterScan.ts test/adapterScan.test.ts && git commit -m "feat(vault): rekursiver Adapter-Scan (inkl. Dotfiles) mit Fake-testbarer Schnittstelle"`

---

## Task 3: Hidden-Sync-Planer (reine Zwei-Wege-Abgleich-Logik)

**Files:** Create `src/vault/hiddenSync.ts`, `test/hiddenSync.test.ts`

**Interfaces:**
- Produces: `planHiddenSync(local: Map<string,string>, known: Map<string,string>, store: Map<string,string>): { uploads: string[]; deleteRemotes: string[] }`
  - `local`: Pfad→Inhalts-Hash der aktuell auf Platte liegenden (regelkonformen) Hidden-Dateien.
  - `known`: Pfad→Hash beim letzten Sync (persistiert).
  - `store`: Pfad→Hash im Store (null/fehlend = nicht vorhanden).
  - Regeln: fehlt lokal + war bekannt → Remote löschen; lokal == store → noop; lokal geändert ggü. known → hochladen (Konflikt möglich, M3 löst); lokal == known aber != store → Remote hat sich geändert → Download übernimmt (noop hier).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/hiddenSync.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { planHiddenSync } from "../src/vault/hiddenSync";

const M = (o: Record<string, string>) => new Map(Object.entries(o));

describe("planHiddenSync", () => {
  it("lädt neue lokale Datei hoch", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({}), M({}));
    expect(p.uploads).toEqual(["a"]);
    expect(p.deleteRemotes).toEqual([]);
  });
  it("lokal geändert (Hash != known) -> hochladen", () => {
    const p = planHiddenSync(M({ "a": "h2" }), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.uploads).toEqual(["a"]);
  });
  it("lokal unverändert, Remote geändert -> Download übernimmt (kein Upload)", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({ "a": "h1" }), M({ "a": "h2" }));
    expect(p.uploads).toEqual([]);
  });
  it("lokal == store -> noop", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.uploads).toEqual([]);
    expect(p.deleteRemotes).toEqual([]);
  });
  it("lokal gelöscht + war bekannt -> Remote löschen", () => {
    const p = planHiddenSync(M({}), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.deleteRemotes).toEqual(["a"]);
  });
  it("lokal fehlt, nie bekannt -> nichts tun", () => {
    const p = planHiddenSync(M({}), M({}), M({ "a": "h1" }));
    expect(p.uploads).toEqual([]);
    expect(p.deleteRemotes).toEqual([]);
  });
});
```

- [ ] **Step 2: Test ausführen → FAIL** — Run: `npx vitest run test/hiddenSync.test.ts`

- [ ] **Step 3: Implementieren**

`src/vault/hiddenSync.ts`:
```ts
export function planHiddenSync(
  local: Map<string, string>,
  known: Map<string, string>,
  store: Map<string, string>,
): { uploads: string[]; deleteRemotes: string[] } {
  const uploads: string[] = [];
  const deleteRemotes: string[] = [];
  const paths = new Set<string>([...local.keys(), ...known.keys()]);
  for (const path of paths) {
    const localHash = local.get(path);
    const knownHash = known.get(path);
    const storeHash = store.get(path);
    if (localHash === undefined) {
      // nicht mehr auf Platte
      if (knownHash !== undefined) deleteRemotes.push(path);
      continue;
    }
    if (localHash === storeHash) continue; // bereits in sync
    if (localHash !== knownHash) {
      uploads.push(path); // lokal geändert -> hochladen (ggf. Konflikt, M3 löst)
    }
    // sonst: lokal == known, aber != store -> Remote hat sich geändert -> Download übernimmt
  }
  return { uploads, deleteRemotes };
}
```

- [ ] **Step 4: Test ausführen → PASS (6 Tests)** — Run: `npx vitest run test/hiddenSync.test.ts`

- [ ] **Step 5: Commit** — `git add src/vault/hiddenSync.ts test/hiddenSync.test.ts && git commit -m "feat(vault): reiner Hidden-Sync-Planer (Zwei-Wege-Abgleich via letzte-Sync-Hashes)"`

---

## Task 4: Plugin-Reload-Planer + Sync-Modus-Logik

**Files:** Create `src/plugins/pluginSync.ts`, `src/store/syncModes.ts`, `test/pluginSync.test.ts`, `test/syncModes.test.ts`

**Interfaces:**
- Produces:
  - `pluginSync.ts`: `planPluginReload(changedPaths: string[]): string[]` (aus geänderten `.obsidian/plugins/<id>/**`-Pfaden die betroffenen Plugin-`id`s ableiten, ohne `vaultbridge`).
  - `syncModes.ts`: `type SyncMode = "continuous" | "interval" | "onOpenClose" | "manual"`; `interface WifiContext { isMobile: boolean; onWifi: boolean; wifiOnly: boolean }`; `shouldReplicateNow(mode: SyncMode, ctx: WifiContext): boolean` (WLAN-Gate + Modus).

- [ ] **Step 1: Fehlschlagende Tests schreiben**

`test/pluginSync.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { planPluginReload } from "../src/plugins/pluginSync";

describe("planPluginReload", () => {
  it("leitet betroffene Plugin-ids aus geänderten Pfaden ab", () => {
    const ids = planPluginReload([
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/plugins/templater/manifest.json",
      "Notiz.md",
    ]);
    expect(ids.sort()).toEqual(["dataview", "templater"]);
  });
  it("schließt vaultbridge selbst aus", () => {
    expect(planPluginReload([".obsidian/plugins/vaultbridge/main.js"])).toEqual([]);
  });
  it("keine Plugin-Pfade -> leer", () => {
    expect(planPluginReload(["Notiz.md", ".claude/x"])).toEqual([]);
  });
});
```

`test/syncModes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldReplicateNow } from "../src/store/syncModes";

describe("shouldReplicateNow", () => {
  it("continuous auf Desktop immer", () => {
    expect(shouldReplicateNow("continuous", { isMobile: false, onWifi: false, wifiOnly: false })).toBe(true);
  });
  it("manual nie automatisch", () => {
    expect(shouldReplicateNow("manual", { isMobile: true, onWifi: true, wifiOnly: false })).toBe(false);
  });
  it("WLAN-Gate blockt ohne WLAN auf Mobile", () => {
    expect(shouldReplicateNow("continuous", { isMobile: true, onWifi: false, wifiOnly: true })).toBe(false);
    expect(shouldReplicateNow("continuous", { isMobile: true, onWifi: true, wifiOnly: true })).toBe(true);
  });
  it("WLAN-Gate egal auf Desktop", () => {
    expect(shouldReplicateNow("continuous", { isMobile: false, onWifi: false, wifiOnly: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Tests ausführen → FAIL** — Run: `npx vitest run test/pluginSync.test.ts test/syncModes.test.ts`

- [ ] **Step 3: Implementieren**

`src/plugins/pluginSync.ts`:
```ts
export function planPluginReload(changedPaths: string[]): string[] {
  const ids = new Set<string>();
  for (const path of changedPaths) {
    const m = path.match(/^\.obsidian\/plugins\/([^/]+)\//);
    if (m && m[1] !== "vaultbridge") ids.add(m[1]);
  }
  return [...ids];
}
```

`src/store/syncModes.ts`:
```ts
export type SyncMode = "continuous" | "interval" | "onOpenClose" | "manual";

export interface WifiContext {
  isMobile: boolean;
  onWifi: boolean;
  wifiOnly: boolean;
}

export function shouldReplicateNow(mode: SyncMode, ctx: WifiContext): boolean {
  if (mode === "manual") return false;
  if (ctx.isMobile && ctx.wifiOnly && !ctx.onWifi) return false;
  // continuous/interval/onOpenClose lösen an anderer Stelle das eigentliche Timing aus;
  // diese Funktion beantwortet nur "darf JETZT repliziert werden?".
  return true;
}
```

- [ ] **Step 4: Tests ausführen → PASS (3 + 4 Tests)** — Run: `npx vitest run test/pluginSync.test.ts test/syncModes.test.ts`

- [ ] **Step 5: Commit** — `git add src/plugins/pluginSync.ts src/store/syncModes.ts test/pluginSync.test.ts test/syncModes.test.ts && git commit -m "feat: Plugin-Reload-Planer + Sync-Modus/WLAN-Gate-Logik (rein, getestet)"`

---

## Task 5: Bridge — Regel-Gating + Hidden-File-Reconcile + Adapter-Anwendung

**Files:** Modify `src/vault/bridge.ts`, `src/store/store.ts` (Hash-Zugriff für Store-Pfade), `src/main.ts` (Wiring). Manuell verifiziert.

**Interfaces:**
- Consumes: `shouldSync`/`SyncRules` (`vault/rules`), `listAllFiles` (`vault/adapterScan`), `planHiddenSync` (`vault/hiddenSync`), `contentHash`.
- Produces: `VaultBridge` nimmt jetzt `SyncRules` + einen persistierten `known`-Hash-Speicher; ein `reconcileHidden()`-Durchlauf; `applyRemote` schreibt versteckte Pfade via `vault.adapter`. `VaultStore.pathHashes()` liefert Pfad→Inhalts-Hash aller aktiven Notes (für den Abgleich).

**Umsetzung (Kernpunkte; vollständiger Code im Task-Brief-Umfang durch den Implementer aus diesen Vorgaben):**

- [ ] **Step 1: `VaultStore.pathHashes()` ergänzen (getestet)** — eine Methode, die für alle nicht-gelöschten Notes `Map<pfad, contentHash(bytes)>` liefert (über `allDocs` + `readNote` + `contentHash`). Test in `test/storeConflict.test.ts`-Stil: zwei Dateien putten → `pathHashes()` enthält beide Pfade mit stabilen Hashes.

- [ ] **Step 2: Bridge-Konstruktor + Gating** — Konstruktor erhält `rules: SyncRules` und eine `getKnown()/setKnown()`-Persistenz (aus `main.ts`, gespeichert in Plugin-Data unter einem eigenen Schlüssel, NICHT im synchronisierten Bereich). In `onLocalWrite`/`onLocalDelete`/`reconcileExisting`/`applyRemote` jeweils zuerst `if (!shouldSync(path, this.rules)) return;`.

- [ ] **Step 3: `reconcileHidden()`** — `listAllFiles(adapter)` → nach `shouldSync` + `isHidden` filtern → für jede Datei `contentHash(adapter.readBinary)` → `local`-Map; `store.pathHashes()` gefiltert auf Hidden → `store`-Map; `known` aus Persistenz; `planHiddenSync(local, known, store)` → `uploads` via `store.putFile(path, bytes, meta)`, `deleteRemotes` via `store.deleteFile(path)`; danach `known` aktualisieren (auf `local`) und persistieren.

- [ ] **Step 4: `applyRemote` für Hidden-Pfade** — wenn `isHidden(note.path)`: statt `vault.createBinary/modifyBinary/delete` die Adapter-API nutzen (`adapter.writeBinary(path, ab)`, `adapter.remove(path)`, Ordner via `adapter.mkdir`), Echo-Guard analog. Nach dem Schreiben `known[path]` aktualisieren. Indizierte Dateien wie bisher.

- [ ] **Step 5: `main.ts`** — Hidden-Reconcile-Loop starten: `registerInterval` (z.B. alle 30 s) + einmal bei `connect()` + bei Sync-Settle; `rules` aus Settings an die Bridge geben.

- [ ] **Step 6: Build + volle Suite** — `npm run build && npm test` (Regel-/Scan-/Plan-Tests grün; Bridge-Wiring typecheckt).

- [ ] **Step 7: Manuelle Verifikation (pending human)** — `.claude/`-Datei auf A ändern → erscheint auf B; Löschung propagiert; kein Loop (Adapter-Schreiben löst kein indiziertes Event, Echo-Guard trotzdem als Sicherheit).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(vault): Regel-Gating + adapter-basierter Hidden-File-Reconcile (Dotfiles/.claude/Plugins)"`

---

## Task 6: Plugin-Sync-Reload-Flow + Mobile-Modi-Wiring

**Files:** Modify `src/main.ts`, `src/store/replication.ts` (falls Modus-Hooks nötig). Manuell verifiziert.

- [ ] **Step 1: Plugin-Reload-Notice** — Nach `reconcileHidden`/Downloads mit geänderten `.obsidian/plugins/**`-Pfaden `planPluginReload(changed)` bilden; wenn nicht leer, eine `Notice` mit Button „Plugins neu laden" zeigen, der pro id `await this.app.plugins.disablePlugin(id); await this.app.plugins.enablePlugin(id);` ausführt. `community-plugins.json`-Änderung → Hinweis „Plugin-Aktivierung geändert (Neustart übernimmt Aktivierung)".

- [ ] **Step 2: Mobile-Modi** — Settings-Feld `syncMode` + `wifiOnly`; in `connect()` `shouldReplicateNow(mode, ctx)` respektieren (ctx aus `Platform.isMobile` von Obsidian + einer einfachen Online/WLAN-Heuristik `navigator.onLine`); `interval` via `registerInterval` einmaliges `sync`; `onOpenClose` via `this.registerEvent(workspace.on("quit", ...))` bzw. beim Laden; `manual` nur „Sync jetzt"-Befehl.

- [ ] **Step 3: „Sync jetzt"-Befehl** — Befehl, der eine einmalige Replikation + `reconcileHidden` auslöst (für `manual`/`interval`).

- [ ] **Step 4: Build + Suite** — `npm run build && npm test`.

- [ ] **Step 5: Manuelle Verifikation (pending human)** — anderes Plugin auf A installieren/aktualisieren → auf B Notice + Neu-laden funktioniert; auf Mobile WLAN-Gate/manueller Modus greifen.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: Plugin-Update-Reload-Flow + Mobile-Sync-Modi (WLAN-Gate, Intervall, manuell)"`

---

## Task 7: Settings-UI (Regel-Editor + Sync-Modus + Toggles)

**Files:** Modify `src/ui/SettingsTab.ts`. Manuell verifiziert.

- [ ] **Step 1: Regel-Editor** — im Settings-Tab: Toggle „Versteckte Dateien synchronisieren" (`syncHidden`), zwei mehrzeilige Textfelder Include/Exclude (eine Glob pro Zeile), „Auf Standard zurücksetzen"-Button (`DEFAULT_RULES`). Persistenz in Plugin-Settings (`rules`), Änderungen wirken beim nächsten Reconnect (Hinweis).

- [ ] **Step 2: Sync-Modus** — Dropdown `syncMode` (kontinuierlich/Intervall/bei App-Start-und-Ende/manuell) + Toggle „Nur im WLAN" (`wifiOnly`), Intervall-Sekunden.

- [ ] **Step 3: Plugin-Sync-Toggle** — sichtbarer Toggle „Plugins & Themes synchronisieren" der die Plugin-Include-Globs de/aktiviert (Komfort ggü. dem rohen Include-Feld), plus Warnhinweis „verteilt fremden Code über Geräte".

- [ ] **Step 4: Build + Suite** — `npm run build && npm test`.

- [ ] **Step 5: Manuelle Verifikation (pending human)** — Regeln bearbeiten, Standard zurücksetzen, Modus wechseln.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(ui): Regel-Editor + Sync-Modus + Plugin-Sync-Toggle in den Einstellungen"`

---

## Task 8: Setup-Generator + QR

**Files:** Modify `package.json` (`qrcode`), create `src/ui/GeneratorModal.ts`, modify `src/main.ts` (+ Command/Settings-Button). Manuell verifiziert.

**Interfaces:** Nutzt `encodeSetup`/`SetupPayload` (M1). Zufalls-Salt via `crypto.getRandomValues`.

- [ ] **Step 1: `qrcode` installieren** — `npm install --save qrcode && npm install --save-dev @types/qrcode`.

- [ ] **Step 2: `GeneratorModal.ts`** — Formular: CouchDB-URL, DB, Benutzer, Passwort, Passphrase (leer = Modus „separate"), Optionen (Pfad-Verschleierung, Chunk-Größe, gzip). „Erzeugen" baut das `SetupPayload` (16-Byte-Zufalls-`kdfSalt` base64url, `kdfIter: 210000`) → `encodeSetup(...)` → zeigt den String (auswählbar) + „In Zwischenablage kopieren" + rendert einen **QR-Code** (`QRCode.toDataURL(string)` in ein `<img>`). Deutliche Warnung „wie ein Passwort behandeln".

- [ ] **Step 3: `main.ts` / Settings** — Befehl „Vaultbridge: Setup-String erzeugen" + Button im Settings-Tab, der das `GeneratorModal` öffnet.

- [ ] **Step 4: Build + Suite** — `npm run build && npm test` (esbuild bündelt `qrcode`; QR-Erzeugung typecheckt). Bei Bundling-Problemen mit `qrcode` denselben Ansatz wie bei PouchDB (nur `qrcode`, keine Node-Polyfills; `qrcode` hat einen Browser-Build `qrcode/lib/browser` — bei Bedarf gezielt importieren).

- [ ] **Step 5: Manuelle Verifikation (pending human)** — Generator öffnen, String erzeugen, QR wird angezeigt, „kopieren" funktioniert; der erzeugte String lässt sich in einer zweiten Instanz einfügen und verbinden.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(ui): In-App-Setup-Generator mit QR-Code"`

---

## Meilenstein-4-Abschluss

Danach: Regel-gesteuerter Sync inkl. versteckter Dateien (`.claude/`, `.obsidian/`), geräteübergreifender Plugin-Sync mit Reload-Flow, Mobile-Sync-Modi (WLAN-Gate/Intervall/manuell), In-App-Setup-Generator mit QR — die reine Logik (Regeln, Scan, Abgleich, Reload, Modi) headless getestet, die Obsidian-gekoppelten Teile manuell zu verifizieren.

**Manuelle Verifikation offen:** `.claude/`-Roundtrip zwischen zwei Instanzen; Plugin-Update + Neu-laden; Mobile-Modi/WLAN-Gate am echten Gerät; Generator/QR.

**Noch nicht enthalten:** In-App-QR-*Scannen* (Kamera) — der QR dient dem Ablesen/Übertragen; M5 Datei-Verlauf; M6 Passphrase-Rotation; M7 Release/Community-Einreichung. Hinweis für Mobile (aus M3-Review): `getRightLeaf(false)!` in `openConflictView` gegen `null` absichern — in Task 7 mit erledigen.
