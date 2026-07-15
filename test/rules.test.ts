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
