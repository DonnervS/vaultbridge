import esbuild from "esbuild";
import vm from "node:vm";
import { createRequire, builtinModules } from "node:module";

const require = createRequire(import.meta.url);

// "events" wird NICHT ausgelagert, sondern gebündelt (browserfähiges Polyfill) —
// muss identisch zur esbuild.config.mjs sein, sonst prüft der Test einen anderen
// Bundle-Stand als das Release.
const externalBuiltins = builtinModules.filter((m) => m !== "events");

const result = await esbuild.build({
  entryPoints: ["src/store/pouch.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2018",
  external: ["obsidian", "electron", ...externalBuiltins],
  logLevel: "silent",
});
const code = result.outputFiles[0].text;

// Mobile-Guard: auf iOS/Android gibt es kein Node, daher darf im Bundle KEIN
// require() auf einen Node-Builtin übrig bleiben (nur "obsidian"/"electron" sind
// von der Laufzeit bereitgestellt). Genau dieser Fall (require("events")) hat das
// Laden auf dem iPhone verhindert und wurde vom reinen Lade-Test unten nicht
// erkannt, weil die Node-Sandbox ein funktionierendes require("events") hat.
const leakedBuiltin = builtinModules.find((m) => code.includes(`require("${m}")`));
if (leakedBuiltin) {
  console.error(
    `FEHLGESCHLAGEN: Bundle enthält require("${leakedBuiltin}") — dieser Node-Builtin ` +
      `fehlt auf Mobile und verhindert das Laden. Aus dem external-Filter nehmen und ein ` +
      `browserfähiges Polyfill bündeln.`,
  );
  process.exit(1);
}

// Sandbox bildet eine Browser-/Electron-Umgebung nach, ABER ohne `global` und
// `process` — genau die Symbole, deren unbewachte Top-Level-Nutzung die
// esbuild/PouchDB-Bundling-Falle auslöst. Legitime, per typeof-Guard genutzte
// Referenzen bleiben unkritisch.
const sandbox = {
  module: { exports: {} },
  require,
  console,
  Buffer,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  fetch,
  Headers,
  Request,
  Response,
};
sandbox.exports = sandbox.module.exports;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

try {
  vm.runInNewContext(code, sandbox, { filename: "pouch-bundle.cjs" });
} catch (e) {
  console.error("FEHLGESCHLAGEN: pouchdb-browser lädt nicht ohne global/process:", e && e.message);
  process.exit(1);
}

const exported = sandbox.module.exports;
const PouchDB = exported.PouchDB ?? exported.default;
if (typeof PouchDB !== "function") {
  console.error("FEHLGESCHLAGEN: pouch.ts exportiert keinen PouchDB-Konstruktor.");
  process.exit(1);
}
console.log(`OK: pouchdb-browser bundelt und lädt ohne global/process (${(code.length / 1024).toFixed(0)} KB unminifiziert).`);
