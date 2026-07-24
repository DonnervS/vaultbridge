import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv.includes("production");

// Node-Builtins bleiben extern (Desktop/Electron stellt sie über Node bereit) —
// MIT AUSNAHME von "events": pouchdb-browser zieht es beim Laden hart per
// require("events"). Auf Mobile (iOS/Android) gibt es kein Node, dieser require
// schlägt fehl und das Plugin lädt nicht ("Cannot find module 'events'"). Daher
// wird das browserfähige npm-Polyfill "events" mitgebündelt statt ausgelagert.
const externalBuiltins = builtinModules.filter((m) => m !== "events");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...externalBuiltins],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js",
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
