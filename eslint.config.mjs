// ESLint-Konfiguration mit dem offiziellen eslint-plugin-obsidianmd —
// dasselbe Regelwerk, das die Obsidian-Verzeichnis-Prüfung für den Quellcode
// verwendet. So lassen sich die dort gemeldeten Errors/Warnings lokal
// reproduzieren und verifiziert beheben.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // UI ist deutschsprachig — sentence-case-Regel (für Englisch) nicht anwendbar
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    ignores: ["main.js", "node_modules/**", "test/**", "scripts/**", "esbuild.config.mjs"],
  },
]);
