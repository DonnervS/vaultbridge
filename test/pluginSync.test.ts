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
  it("respektiert einen umbenannten Konfigordner (configDir)", () => {
    const ids = planPluginReload(
      [".myconfig/plugins/dataview/main.js", ".myconfig/plugins/vaultbridge/main.js", ".obsidian/plugins/x/main.js"],
      ".myconfig",
    );
    expect(ids).toEqual(["dataview"]); // vaultbridge raus; .obsidian-Pfad zählt bei .myconfig nicht
  });
});
