import { describe, it, expect } from "vitest";
import {
  shouldSync,
  isHidden,
  matchesEntry,
  folderIsExcluded,
  migrateRules,
  cloneRules,
  syncRuleState,
  setInclusion,
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

  it("schließt .git-Interna standardmäßig aus (Datei-Sync würde Repos beschädigen)", () => {
    expect(shouldSync("Dev/projekt/.git/config", DEFAULT_RULES)).toBe(false);
    expect(shouldSync("Dev/projekt/.git/objects/ab/cd", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".git/HEAD", DEFAULT_RULES)).toBe(false);
  });

  it("synct node_modules standardmäßig (Nutzer schließt bei Bedarf selbst aus)", () => {
    expect(shouldSync("Dev/p/node_modules/x.js", DEFAULT_RULES)).toBe(true);
  });
});

describe("configDir (nicht-standard Konfigordner)", () => {
  // Der Nutzer kann Obsidians Konfigordner umbenennen (nicht immer ".obsidian").
  // Die config-abhängigen Ausschlüsse müssen dann aus dem echten configDir gebildet
  // werden — sonst würden geräte-lokale Dateien fälschlich gesynct oder umgekehrt.
  const cd = ".myconfig";

  it("configExclude greift für workspace/graph im umbenannten Konfigordner", () => {
    expect(shouldSync(".myconfig/workspace.json", DEFAULT_RULES, cd)).toBe(false);
    expect(shouldSync(".myconfig/workspace-mobile.json", DEFAULT_RULES, cd)).toBe(false);
    expect(shouldSync(".myconfig/graph.json", DEFAULT_RULES, cd)).toBe(false);
  });

  it("hardExclude schützt Vaultbridge-Self im umbenannten Konfigordner", () => {
    const permissive: SyncRules = { syncHidden: true, include: [], exclude: [] };
    expect(shouldSync(".myconfig/plugins/vaultbridge/data.json", permissive, cd)).toBe(false);
    expect(shouldSync(".myconfig/plugins/vaultbridge/main.js", permissive, cd)).toBe(false);
  });

  it("andere Plugins/Config-Dateien im umbenannten Konfigordner syncen weiterhin", () => {
    expect(shouldSync(".myconfig/plugins/andere/main.js", DEFAULT_RULES, cd)).toBe(true);
    expect(shouldSync(".myconfig/appearance.json", DEFAULT_RULES, cd)).toBe(true);
  });

  it("bei nicht-standard configDir ist .obsidian nur eine gewöhnliche Hidden-Datei (kein configExclude)", () => {
    // configDir=".myconfig": ".obsidian/workspace.json" ist KEIN configExclude für
    // diesen configDir -> synct wie jede andere versteckte Datei.
    expect(shouldSync(".obsidian/workspace.json", DEFAULT_RULES, cd)).toBe(true);
    // ... während der echte configDir greift:
    expect(shouldSync(".myconfig/workspace.json", DEFAULT_RULES, cd)).toBe(false);
  });

  it("Standard-configDir (Default-Argument) schließt .obsidian/workspace + graph weiterhin aus", () => {
    expect(shouldSync(".obsidian/workspace.json", DEFAULT_RULES)).toBe(false);
    expect(shouldSync(".obsidian/graph.json", DEFAULT_RULES)).toBe(false);
  });

  it("syncRuleState/setInclusion reichen configDir korrekt durch", () => {
    const base: SyncRules = { syncHidden: true, include: [], exclude: [], rulesVersion: RULES_VERSION };
    // Vaultbridge-Self im umbenannten configDir -> forced (nicht steuerbar):
    expect(syncRuleState(".myconfig/plugins/vaultbridge/main.js", base, cd).reason).toBe("forced");
    // configExclude ohne eigenen Nutzer-Eintrag -> excluded-parent (nur per Include übersteuerbar):
    expect(syncRuleState(".myconfig/workspace.json", base, cd)).toEqual({ synced: false, reason: "excluded-parent" });
    // Include übersteuert den configExclude auch bei nicht-standard configDir:
    const withInclude = setInclusion(".myconfig/workspace.json", true, base, cd);
    expect(shouldSync(".myconfig/workspace.json", withInclude, cd)).toBe(true);
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

  it("prunt NIE über Globs (Glob kann Ordner treffen, aber nicht alle Nachfahren)", () => {
    const r: SyncRules = { syncHidden: true, include: [], exclude: ["Dev/*"] };
    // Der Ordner Dev/.config würde vom Glob getroffen ...
    expect(folderIsExcluded("Dev/.config", r)).toBe(false); // ... darf aber NICHT geprunt werden,
    // denn die tiefere Datei soll synchronisiert werden:
    expect(shouldSync("Dev/.config/keys.json", r)).toBe(true);
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
    expect(v2.exclude).toContain(".git"); // v2-Default dazu (workspace/graph laufen jetzt zur Laufzeit über configDir)
    // Effektiv weiter ausgeschlossen: geräte-lokale Config-Dateien via configExcludes (Standard-configDir):
    expect(shouldSync(".obsidian/workspace.json", v2)).toBe(false);
  });

  it("verwirft KEINEN Ausschluss, auch wenn er wie eine alte Include-Glob aussieht", () => {
    // Ein v1-Nutzer hatte .claude/** bewusst im AUSSCHLUSS (nicht syncen).
    const v1: SyncRules = { syncHidden: true, include: [], exclude: [".claude/**", ".obsidian/plugins/**"] };
    const v2 = migrateRules(v1);
    expect(v2.exclude).toContain(".claude/**");
    expect(v2.exclude).toContain(".obsidian/plugins/**");
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

describe("syncRuleState (Kontextmenü-Zustand)", () => {
  const base: SyncRules = { syncHidden: true, include: [], exclude: [], rulesVersion: RULES_VERSION };

  it("normaler Pfad -> default (wird gesynct)", () => {
    expect(syncRuleState("Projekte/A.md", base)).toEqual({ synced: true, reason: "default" });
  });

  it("eigener Ausschluss-Eintrag -> excluded-self", () => {
    const r = { ...base, exclude: ["Projekte/Geheim"] };
    expect(syncRuleState("Projekte/Geheim", r)).toEqual({ synced: false, reason: "excluded-self" });
  });

  it("über den Elternordner ausgeschlossen -> excluded-parent", () => {
    const r = { ...base, exclude: ["Projekte"] };
    expect(syncRuleState("Projekte/Unter/x.md", r)).toEqual({ synced: false, reason: "excluded-parent" });
  });

  it("Include-Ausnahme trotz Elternausschluss -> included-exception", () => {
    const r = { ...base, exclude: ["Projekte"], include: ["Projekte/Wichtig.md"] };
    expect(syncRuleState("Projekte/Wichtig.md", r)).toEqual({ synced: true, reason: "included-exception" });
  });

  it("Vaultbridge-eigenes Verzeichnis + Sidecar -> forced", () => {
    expect(syncRuleState(".obsidian/plugins/vaultbridge/main.js", base).reason).toBe("forced");
    expect(syncRuleState("Notiz.md.vaultbridge-konflikt", base).reason).toBe("forced");
  });

  it("versteckte Datei bei syncHidden=aus -> forced", () => {
    expect(syncRuleState(".claude/x.md", { ...base, syncHidden: false }).reason).toBe("forced");
  });
});

describe("setInclusion (robustes Ein-/Ausschließen)", () => {
  const base: SyncRules = { syncHidden: true, include: [], exclude: [], rulesVersion: RULES_VERSION };

  it("ausschließen fügt einen Ausschluss-Eintrag hinzu", () => {
    const r = setInclusion("Projekte/Geheim", false, base);
    expect(shouldSync("Projekte/Geheim", r)).toBe(false);
    expect(shouldSync("Projekte/Geheim/tief.md", r)).toBe(false); // Teilbaum mit
  });

  it("einschließen eines eigenen Ausschlusses entfernt den Eintrag", () => {
    const r = setInclusion("Projekte/Geheim", true, { ...base, exclude: ["Projekte/Geheim"] });
    expect(shouldSync("Projekte/Geheim", r)).toBe(true);
    expect(r.exclude).not.toContain("Projekte/Geheim");
  });

  it("einschließen bei Elternausschluss ergänzt eine Include-Ausnahme (Kernfall)", () => {
    const r = setInclusion("Projekte/Wichtig.md", true, { ...base, exclude: ["Projekte"] });
    expect(shouldSync("Projekte/Wichtig.md", r)).toBe(true);
    expect(shouldSync("Projekte/Anderes.md", r)).toBe(false); // Rest bleibt ausgeschlossen
    expect(r.include).toContain("Projekte/Wichtig.md");
  });

  it("ausschließen hebt eine bestehende Include-Ausnahme auf", () => {
    const r = setInclusion("Projekte/Wichtig.md", false, { ...base, exclude: ["Projekte"], include: ["Projekte/Wichtig.md"] });
    expect(shouldSync("Projekte/Wichtig.md", r)).toBe(false);
    expect(r.include).not.toContain("Projekte/Wichtig.md");
  });

  it("lässt das Original unverändert (rein)", () => {
    const src = cloneRules(base);
    setInclusion("X", false, src);
    expect(src.exclude).toEqual([]);
  });

  it("ist idempotent (zweimal ausschließen erzeugt keinen Doppel-Eintrag)", () => {
    const once = setInclusion("A/B", false, base);
    const twice = setInclusion("A/B", false, once);
    expect(twice.exclude.filter((e) => e === "A/B").length).toBe(1);
  });
});
