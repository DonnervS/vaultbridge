import esbuild from "esbuild";
import builtins from "builtin-modules";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const result = await esbuild.build({
  entryPoints: ["src/store/pouch.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2018",
  external: ["obsidian", "electron", ...builtins],
  logLevel: "silent",
});
const code = result.outputFiles[0].text;

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
