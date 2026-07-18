import { describe, it, expect } from "vitest";
import {
  shouldSync,
  isHidden,
  matchesEntry,
  folderIsExcluded,
  migrateRules,
  cloneRules,
  DEFAULT_RULES,
  RULES_VERSION,
  SyncRules,
} from "../src/vault/rules";

const rules: SyncRules = {
  syncHidden: true,
  include: [],
  exclude: [".obsidian/workspace*.json", ".trash", "node_modules"],
  rulesVersion: RULES_VERSION,
};

describe("rules – Grundmodell (alles syncen, ausschluss-basiert)", () => {
  it("normale Dateien werden synchronisiert", () => {
    expect(shouldSync("Notiz.md", rules)).toBe(true);
    expect(shouldSync("Ordner/Unter/x.md", rules)).toBe(true);
  });

  it("versteckte Dateien syncen standardmäßig (kein Include-Tor mehr nötig)", () => {
    expect(shouldSync(".claude/config.md", rules)).toBe(true);
    expect(shouldSync(".hinote/state.json", rules)).toBe(true);
    expect(shouldSync(".obsidian/appearance.json", rules)).toBe(true);
    expect(shouldSync(".obsidian/plugins/foo/main.js", rules)).toBe(true);
  });

  it("verschachteltes .claude / .hinote in einem Dev-Ordner wird erfasst", () => {
    expect(shouldSync("Dev/projekt/.claude/agents/writer.md", rules)).toBe(true);
    expect(shouldSync("Dev/projekt/.hinote/notes.json", rules)).toBe(true);
  });

  it("syncHidden=false schaltet ALLE versteckten Dateien ab", () => {
    const off = { ...rules, syncHidden: false };
    expect(shouldSync(".claude/config.md", off)).toBe(false);
    expect(shouldSync("Dev/projekt/.claude/x.md", off)).toBe(false);
    expect(shouldSync("Notiz.md", off)).toBe(true); // normale bleiben
  });
});

describe("rules – Ausschluss ergonomisch (Datei / Ordner / Name überall)", () => {
  it("Ordnername ohne Schrägstrich schließt überall aus (samt Unterordnern)", () => {
    expect(shouldSync("Dev/projekt/node_modules/lodash/index.js", rules)).toBe(false);
    expect(shouldSync("node_modules/x.js", rules)).toBe(false);
    expect(shouldSync("a/b/c/node_modules/deep/y.js", rules)).toBe(false);
  });

  it("exakter Dateipfad schließt genau die Datei aus", () => {
    const r: SyncRules = { syncHidden: true, include: [], exclude: ["Dev/geheim.md"] };
    expect(shouldSync("Dev/geheim.md", r)).toBe(false);
    expect(shouldSync("Dev/geheim.md.bak", r)).toBe(true);
    expect(shouldSync("Anders/geheim.md", r)).toBe(true);
  });

  it("Ordnerpfad schließt den ganzen Teilbaum aus", () => {
    const r: SyncRules = { syncHidden: true, include: [], exclude: ["Dev/projekt/build"] };
    expect(shouldSync("Dev/projekt/build/out.js", r)).toBe(false);
    expect(shouldSync("Dev/projekt/build", r)).toBe(false);
    expect(shouldSync("Dev/projekt/src/main.ts", r)).toBe(true);
  });

  it("Dateiname ohne Schrägstrich trifft die Datei überall", () => {
    const r: SyncRules = { syncHidden: true, include: [], exclude: ["secret.env"] };
    expect(shouldSync("secret.env", r)).toBe(false);
    expect(shouldSync("Dev/a/secret.env", r)).toBe(false);
    expect(shouldSync("Dev/a/other.env", r)).toBe(true);
  });

  it("Globs (* / **) funktionieren weiterhin für Power-User", () => {
    const r: SyncRules = { syncHidden: true, include: [], exclude: ["**/*.log", ".obsidian/workspace*.json"] };
    expect(shouldSync("Dev/a/run.log", r)).toBe(false);
    expect(shouldSync(".obsidian/workspace-mobile.json", r)).toBe(false);
    expect(shouldSync("Dev/a/run.txt", r)).toBe(true);
  });
});

describe("rules – Include als Wieder-Einschluss-Ausnahme", () => {
  it("Include überschreibt einen Ausschluss", () => {
    const r: SyncRules = {
      syncHidden: true,
      include: ["Dev/projekt/build/keep.js"],
      exclude: ["build"],
    };
    expect(shouldSync("Dev/projekt/build/out.js", r)).toBe(false);
    expect(shouldSync("Dev/projekt/build/keep.js", r)).toBe(true);
  });
});

describe("rules – harte Ausnahmen", () => {
  it("Vaultbridge' eigenes Verzeichnis wird NIE synchronisiert", () => {
    const permissive: SyncRules = { syncHidden: true, include: [], exclude: [] };
    expect(shouldSync(".obsidian/plugins/vaultbridge/main.js", permissive)).toBe(false);
    expect(shouldSync(".obsidian/plugins/vaultbridge/data.json", permissive)).toBe(false);
    expect(shouldSync(".obsidian/plugins/andere/main.js", permissive)).toBe(true);
  });

  it("Konflikt-Sidecar-Dateien werden nie synchronisiert", () => {
    const permissive: SyncRules = { syncHidden: true, include: [], exclude: [] };
    expect(shouldSync(".claude/x.md.vaultbridge-konflikt", permissive)).toBe(false);
    expect(shouldSync("root.vaultbridge-konflikt", permissive)).toBe(false);
  });
});

describe("rules – DEFAULT_RULES", () => {
  it("synct .claude/.hinote (auch verschachtelt) und normale Notizen", () => {
    expect(shouldSync("Notiz.md", DEFAULT_RULES)).toBe(true);
    expect(shouldSync(".claude/agents/x.md", DEFAULT_RULES)).toBe(true);
    expect(shouldSync("Dev/p/.claude/x.md", DEFAULT_RULES)).toBe(true);
    expect(shouldSync(".hinote/state.json", DEFAULT_RULES)).toBe(true);
    expect(shouldSync(".obsidian/plugins/andere/main.js", DEFAULT_RULES)).toBe(true);
  });

  it("schließt geräte-lokale Churn-Dateien und Vaultbridge-Self aus", () => {
    expect(shouldSync(".obsidian/workspace.json", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".obsidian/workspace-mobile.json", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".obsidian/graph.json", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".trash/geloescht.md", DEFAULT_RULES)).toBe(false);
    expect(shouldSync("Dev/p/.DS_Store", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".obsidian/plugins/vaultbridge/main.js", DEFAULT_RULES)).toBe(false);
  });

  it("synct node_modules standardmäßig (Nutzer schließt bei Bedarf selbst aus)", () => {
    expect(shouldSync("Dev/p/node_modules/x.js", DEFAULT_RULES)).toBe(true);
  });
});

describe("matchesEntry", () => {
  it("normalisiert führendes ./ und abschließende /", () => {
    expect(matchesEntry("Dev/x.md", "./Dev/x.md")).toBe(true);
    expect(matchesEntry("Dev/build/y.js", "Dev/build/")).toBe(true);
  });
});

describe("folderIsExcluded (Scan-Pruning)", () => {
  it("erkennt vollständig ausgeschlossene Ordner", () => {
    expect(folderIsExcluded("Dev/p/node_modules", rules)).toBe(true);
    expect(folderIsExcluded(".trash", rules)).toBe(true);
    expect(folderIsExcluded("Dev/p/src", rules)).toBe(false);
  });

  it("prunt nicht, wenn es Include-Ausnahmen gibt (Korrektheit vor Perf)", () => {
    const r: SyncRules = { syncHidden: true, include: ["node_modules/keep.js"], exclude: ["node_modules"] };
    expect(folderIsExcluded("node_modules", r)).toBe(false);
  });
});

describe("migrateRules (v1 -> v2)", () => {
  it("undefined/null -> frische Defaults", () => {
    expect(migrateRules(undefined)).toEqual(DEFAULT_RULES);
    expect(migrateRules(null)).toEqual(DEFAULT_RULES);
  });

  it("v1-Regeln (Allowlist) werden auf v2 gehoben: Allowlist verworfen, alles synct", () => {
    const v1: SyncRules = {
      syncHidden: true,
      include: [".claude/**", ".obsidian/plugins/**", ".obsidian/appearance.json"],
      exclude: [".obsidian/workspace*.json", ".trash/**"],
    };
    const v2 = migrateRules(v1);
    expect(v2.rulesVersion).toBe(RULES_VERSION);
    expect(v2.include).toEqual([]);
    // .claude synct jetzt (auch verschachtelt), ohne Allowlist:
    expect(shouldSync("Dev/p/.claude/x.md", v2)).toBe(true);
    expect(shouldSync(".obsidian/appearance.json", v2)).toBe(true);
  });

  it("Custom-Ausschlüsse eines v1-Nutzers bleiben erhalten", () => {
    const v1: SyncRules = {
      syncHidden: true,
      include: [".claude/**"],
      exclude: ["node_modules", "MeinGeheimordner"],
    };
    const v2 = migrateRules(v1);
    expect(v2.exclude).toContain("node_modules");
    expect(v2.exclude).toContain("MeinGeheimordner");
    expect(v2.exclude).toContain(".obsidian/workspace*.json"); // v2-Default dazu
  });

  it("v2-Regeln werden unverändert (aber frisch kopiert) zurückgegeben", () => {
    const v2: SyncRules = { syncHidden: false, include: [], exclude: ["x"], rulesVersion: RULES_VERSION };
    const out = migrateRules(v2);
    expect(out).toEqual(v2);
    expect(out.exclude).not.toBe(v2.exclude); // Kopie, kein geteilter Ref
  });
});

describe("isHidden", () => {
  it("erkennt Dotfile-Segmente", () => {
    expect(isHidden(".claude/x")).toBe(true);
    expect(isHidden("a/.git/config")).toBe(true);
    expect(isHidden("normal/datei.md")).toBe(false);
  });
});

describe("cloneRules", () => {
  it("kopiert Arrays und setzt aktuelle Version", () => {
    const src: SyncRules = { syncHidden: true, include: ["a"], exclude: ["b"] };
    const c = cloneRules(src);
    expect(c.include).not.toBe(src.include);
    expect(c.rulesVersion).toBe(RULES_VERSION);
  });
});
