import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
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
