export interface SyncRules {
  syncHidden: boolean;
  // "Trotzdem synchronisieren"-Ausnahmen: überschreiben einen Ausschluss
  // (selten gebraucht). Leer = nichts wird wieder hereingeholt.
  include: string[];
  // Das primäre Steuerinstrument: Was hier steht, wird nie synchronisiert.
  exclude: string[];
  // Schema-Version der Regeln (für Migration v1 -> v2). Fehlt bei Altdaten.
  rulesVersion?: number;
}

// Aktuelle Regel-Schema-Version. v2 = "alles syncen, ausschluss-basiert".
export const RULES_VERSION = 2;

// Nie synchronisieren (nicht abschaltbar): Vaultbridge' eigenes Verzeichnis
// und die Konflikt-Sidecar-Dateien.
const HARD_EXCLUDE = [".obsidian/plugins/vaultbridge/**", "*.vaultbridge-konflikt", "**/*.vaultbridge-konflikt"];

// Modell (v2): Standardmäßig wird ALLES synchronisiert — normale Notizen wie
// auch versteckte Dateien/Ordner (z. B. .claude, .hinote), sofern der Toggle
// `syncHidden` an ist. Gesteuert wird über AUSSCHLÜSSE. Die wenigen Defaults
// unten sind Dateien, die geräte-lokal/transient sind und beim Syncen aktiv
// Konflikt-Churn erzeugen würden — allesamt in den Einstellungen editierbar.
export const DEFAULT_RULES: SyncRules = {
  syncHidden: true,
  include: [],
  exclude: [
    ".obsidian/workspace*.json", // geräte-lokaler Fenster-/UI-Zustand
    ".obsidian/graph.json",      // geräte-lokale Graph-Ansicht
    ".git",                      // Git-Interna — Datei-Sync würde Repos beschädigen (überall)
    ".trash",                    // Obsidian-Papierkorb (überall)
    ".DS_Store",                 // macOS-Metadaten (überall)
  ],
  rulesVersion: RULES_VERSION,
};

export function isHidden(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

function isGlob(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

function normalizeEntry(entry: string): string {
  let e = entry.trim();
  if (e.startsWith("./")) e = e.slice(2);
  while (e.endsWith("/")) e = e.slice(0, -1);
  return e;
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

/**
 * Prüft, ob ein Pfad zu einem Regel-Eintrag passt. Ergonomik (ohne dass der
 * Nutzer Glob-Syntax kennen muss):
 *  - Enthält der Eintrag `*`/`?`, wird er als Glob gegen den ganzen Pfad geprüft.
 *  - Ein exakter Dateipfad (`Dev/projekt/geheim.md`) trifft genau diese Datei.
 *  - Ein Ordnerpfad (`Dev/projekt/node_modules`) trifft den Ordner samt allen
 *    Unterordnern/Dateien.
 *  - Ein einzelner Name ohne Schrägstrich (`node_modules`, `geheim.md`) trifft
 *    jeden gleichnamigen Ordner ODER jede gleichnamige Datei überall im Baum.
 */
export function matchesEntry(path: string, entry: string): boolean {
  const e = normalizeEntry(entry);
  if (e.length === 0) return false;
  if (isGlob(e)) return globToRegex(e).test(path);
  if (path === e) return true; // exakte Datei
  if (path.startsWith(e + "/")) return true; // Ordner-Teilbaum an genau dieser Stelle
  if (!e.includes("/")) {
    // Einzel-Segment: überall passender Ordner- oder Dateiname.
    return path.split("/").includes(e);
  }
  return false;
}

function matchesAny(path: string, entries: string[]): boolean {
  return entries.some((entry) => matchesEntry(path, entry));
}

/**
 * Entscheidet, ob ein Pfad synchronisiert wird.
 *  1. Harte Ausnahmen (Vaultbridge-Self, Sidecars) gewinnen immer.
 *  2. Versteckte Dateien nur, wenn der Toggle `syncHidden` an ist.
 *  3. Ausgeschlossene Pfade werden nicht synchronisiert — es sei denn, ein
 *     Include-Eintrag holt sie ausdrücklich wieder herein.
 *  4. Sonst: synchronisieren (Default = alles).
 */
export function shouldSync(path: string, rules: SyncRules): boolean {
  if (matchesAny(path, HARD_EXCLUDE)) return false;
  if (isHidden(path) && !rules.syncHidden) return false;
  if (matchesAny(path, rules.exclude)) {
    return matchesAny(path, rules.include); // Include überschreibt Exclude
  }
  return true;
}

/**
 * Ob ein Ordner-Teilbaum beim Scan gar nicht erst betreten werden muss, weil er
 * vollständig ausgeschlossen ist. Konservativ: nur wenn es keine Include-
 * Ausnahmen gibt, die etwas im Ordner wieder hereinholen könnten. Reines Perf-
 * Hilfsmittel — es ändert nie, WELCHE Dateien am Ende synchronisiert werden.
 */
export function folderIsExcluded(folderPath: string, rules: SyncRules): boolean {
  if (rules.include.length > 0) return false;
  // Nur Nicht-Glob-Einträge haben garantierte Teilbaum-Semantik. Ein Glob wie
  // `Dev/*` kann den Ordner `Dev/x` treffen, ohne dessen Nachfahren
  // `Dev/x/tief.md` zu treffen — über solche Einträge NIE prunen, sonst würden
  // Dateien fälschlich vom Scan ausgeschlossen.
  return rules.exclude.some((e) => !isGlob(e) && matchesEntry(folderPath, e));
}

/**
 * Migriert persistierte Regeln auf die aktuelle Schema-Version. v1 kannte eine
 * Include-Allowlist als Pflichttor für versteckte Dateien; v2 synchronisiert
 * versteckte Dateien standardmäßig und steuert über Ausschlüsse. Custom-
 * Ausschlüsse des Nutzers bleiben erhalten (vereinigt mit den v2-Defaults).
 */
export function migrateRules(raw: SyncRules | undefined | null): SyncRules {
  if (!raw) return cloneRules(DEFAULT_RULES);
  if (raw.rulesVersion === RULES_VERSION) return cloneRules(raw);
  // Custom-Ausschlüsse des Nutzers immer behalten (Ausschluss ist die sichere
  // Richtung) und mit den v2-Defaults vereinigen.
  const exclude = [...new Set([...DEFAULT_RULES.exclude, ...(raw.exclude ?? [])])];
  return {
    syncHidden: raw.syncHidden ?? true,
    include: [], // v1-Allowlist verworfen — v2 synct versteckte Dateien ohnehin
    exclude,
    rulesVersion: RULES_VERSION,
  };
}

export function cloneRules(rules: SyncRules): SyncRules {
  return {
    syncHidden: rules.syncHidden,
    include: [...rules.include],
    exclude: [...rules.exclude],
    rulesVersion: RULES_VERSION,
  };
}

/**
 * Ob ein Regel-Eintrag GENAU diesen Pfad meint (und nicht bloß als Vorfahre
 * eines Teilbaums). Grundlage, um „direkt ausgeschlossen" (eigener Eintrag,
 * entfernbar) von „über den Elternordner ausgeschlossen" (Ausnahme nötig) zu
 * unterscheiden. Globs zählen bewusst nicht als „exakt" — sie werden wie ein
 * übergeordneter Ausschluss behandelt.
 */
function entryTargetsExactly(path: string, entry: string): boolean {
  const e = normalizeEntry(entry);
  if (e.length === 0 || isGlob(e)) return false;
  if (path === e) return true; // exakter Pfad
  if (!e.includes("/")) {
    // Einzel-Segment: „exakt" nur, wenn es der Name DIESES Pfads ist (letztes
    // Segment) — bei einem Vorfahren-Segment ist es ein Elternteil-Ausschluss.
    const segs = path.split("/");
    return segs[segs.length - 1] === e;
  }
  return false;
}

export type SyncRuleReason =
  | "forced"             // hart ausgeschlossen (Vaultbridge-Self/Sidecar) oder versteckt bei syncHidden=aus
  | "default"            // wird synchronisiert, kein Ausschluss betrifft ihn
  | "included-exception" // wird synchronisiert, obwohl ein Ausschluss greift — eine Include-Ausnahme holt ihn zurück
  | "excluded-self"      // nicht synchronisiert wegen eines EIGENEN Ausschluss-Eintrags (direkt entfernbar)
  | "excluded-parent";   // nicht synchronisiert, weil ein übergeordneter Ordner/Glob ausgeschlossen ist

export interface SyncRuleState {
  synced: boolean;
  reason: SyncRuleReason;
}

/**
 * Bestimmt den Sync-Zustand eines Pfads für das kontextabhängige Menü. „forced"
 * (nicht steuerbar), sonst je nachdem, ob und WIE der Pfad ein-/ausgeschlossen
 * ist — daraus leitet das Menü Beschriftung und Aktion ab.
 */
export function syncRuleState(path: string, rules: SyncRules): SyncRuleState {
  if (matchesAny(path, HARD_EXCLUDE)) return { synced: false, reason: "forced" };
  if (isHidden(path) && !rules.syncHidden) return { synced: false, reason: "forced" };
  if (shouldSync(path, rules)) {
    if (matchesAny(path, rules.exclude) && matchesAny(path, rules.include)) {
      return { synced: true, reason: "included-exception" };
    }
    return { synced: true, reason: "default" };
  }
  const selfExcluded = rules.exclude.some((e) => entryTargetsExactly(path, e));
  return { synced: false, reason: selfExcluded ? "excluded-self" : "excluded-parent" };
}

/**
 * Setzt für einen Pfad robust den gewünschten Sync-Zustand und gibt die
 * angepassten Regeln zurück (das Original bleibt unverändert). Garantiert
 * `shouldSync(path) === include` — unabhängig vom Ausgangszustand:
 *  - Einschließen: eigene Ausschluss-Einträge dieses Pfads entfernen; greift dann
 *    noch ein übergeordneter Ausschluss, eine Include-Ausnahme ergänzen.
 *  - Ausschließen: Include-Ausnahmen dieses Pfads entfernen; wird er dann noch
 *    synchronisiert, einen Ausschluss-Eintrag ergänzen.
 * `forced`-Pfade (hart/hidden) lassen sich so NICHT einschließen — das prüft der
 * Aufrufer über syncRuleState vorab.
 */
export function setInclusion(path: string, include: boolean, rules: SyncRules): SyncRules {
  const next = cloneRules(rules);
  if (include) {
    next.exclude = next.exclude.filter((e) => !entryTargetsExactly(path, e));
    if (!shouldSync(path, next) && !next.include.some((e) => normalizeEntry(e) === path)) {
      next.include.push(path);
    }
  } else {
    next.include = next.include.filter((e) => !entryTargetsExactly(path, e));
    if (shouldSync(path, next) && !next.exclude.some((e) => normalizeEntry(e) === path)) {
      next.exclude.push(path);
    }
  }
  return next;
}
