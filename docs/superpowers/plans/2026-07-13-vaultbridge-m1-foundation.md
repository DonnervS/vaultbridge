# Vaultbridge — Meilenstein 1: Fundament (Scaffold + Krypto + Setup-String + Selbsttest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein installierbares Obsidian-Plugin (Desktop + Mobile), das einen `vbridge1:`-Setup-String parst, daraus per PBKDF2/HKDF Schlüssel ableitet und über einen Selbsttest-Button Verschlüsselungs-Roundtrip + CouchDB-Verbindung/Auth nachweist.

**Architecture:** Frische TypeScript-Codebasis nach dem qeridoo-Muster (PouchDB ↔ CouchDB), aber offen und mobiltauglich. Meilenstein 1 legt Projekt-Scaffold und die reinen, headless testbaren Kernbausteine (`crypto/`, `setup/`) an und verdrahtet sie in ein minimales Plugin mit Settings-Tab und Selbsttest. Noch **kein** PouchDB/Replikation — das kommt in Meilenstein 2.

**Tech Stack:** TypeScript, esbuild (Bundling), Vitest (Tests), WebCrypto (`crypto.subtle`), Obsidian Plugin API. Keine Node-APIs (Mobile-Kompatibilität).

## Global Constraints

- `manifest.json`: `id: "vaultbridge"`, `minAppVersion: "1.4.0"`, `isDesktopOnly: false`.
- Nur Web-APIs + Obsidian-Adapter — **keine** Node-Module (`fs`, `path`, `Buffer`, `crypto` aus Node). Verschlüsselung ausschließlich über WebCrypto (`crypto.subtle`, `crypto.getRandomValues`).
- Verschlüsselung: AES-256-GCM; Schlüsselableitung PBKDF2-HMAC-SHA256 mit `kdfIter ≥ 210000`; Teilschlüssel via HKDF-SHA256 mit getrennten `info`-Labels; Pfad-id via HMAC-SHA256.
- Krypto-Feldformat: `[1 Byte Version=1][12 Byte IV][Ciphertext inkl. GCM-Tag]`.
- Setup-String-Präfix: `vbridge1:`, Nutzlast base64url-kodiertes JSON, `v: 1`.
- Keine Telemetrie, kein hartkodierter Server, keine gebündelten Zugangsdaten, kein Nachladen von Code (Obsidian-Community-Richtlinien).
- UI-Strings auf Deutsch; README/Community-Doku auf Englisch (spätere Meilensteine).
- TDD: erst der fehlschlagende Test, dann minimale Implementierung. Häufige Commits. DRY, YAGNI.
- Arbeitsverzeichnis (Projekt-Root) für alle Pfade: `23 obsidian-sync/vaultbridge/`. Git ist bereits initialisiert.

---

## Dateistruktur (Meilenstein 1)

```
vaultbridge/
  manifest.json              # Plugin-Manifest
  package.json               # Deps + Scripts (build, dev, test)
  tsconfig.json
  esbuild.config.mjs         # main.ts -> main.js
  vitest.config.ts           # Test-Setup (WebCrypto in Node)
  versions.json              # { "1.0.0": "1.4.0" }
  styles.css                 # (leer/minimal in M1)
  test/
    setup.ts                 # WebCrypto-Polyfill-Guard für Node
    encoding.test.ts
    crypto.test.ts
    setupString.test.ts
    connection.test.ts
    selfTest.test.ts
  src/
    crypto/
      encoding.ts            # base64url/hex/utf8-Helfer
      crypto.ts              # deriveKeys, encryptBytes, decryptBytes, pathId
    setup/
      setupString.ts         # encodeSetup, decodeSetup, Typen
      connection.ts          # testConnection (CouchDB)
      selfTest.ts            # runSelfTest (Krypto + Verbindung)
    ui/
      SettingsTab.ts         # Settings-Oberfläche + Selbsttest-Button
    main.ts                  # Plugin-Lebenszyklus, Datenpersistenz
```

**Verantwortlichkeiten:** `crypto/` ist rein und ohne Obsidian/Netzwerk (maximal testbar). `setup/` kapselt String-Kodierung, Verbindungsprüfung und die Selbsttest-Orchestrierung; `connection`/`selfTest` erhalten `fetch` als injizierbare Abhängigkeit → headless testbar. `ui/` und `main.ts` verdrahten nur und werden manuell in Obsidian geprüft.

---

## Task 1: Projekt-Scaffold & Toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `manifest.json`, `versions.json`, `styles.css`, `test/setup.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: lauffähige Skripte `npm run build` (erzeugt `main.js`), `npm test` (Vitest). Ein triviales `src/main.ts` folgt in Task 6; für den Build-Test in diesem Task genügt eine Platzhalter-Datei.

- [ ] **Step 1: `package.json` anlegen**

```json
{
  "name": "vaultbridge",
  "version": "1.0.0",
  "description": "Ende-zu-Ende-verschlüsseltes Obsidian-Vault-Sync gegen CouchDB.",
  "type": "module",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc --noEmit --skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "keywords": ["obsidian", "sync", "couchdb", "encryption"],
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.11.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.20.0",
    "obsidian": "^1.4.11",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` anlegen**

```json
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["DOM", "ES2020"],
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: `esbuild.config.mjs` anlegen**

```js
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
```

- [ ] **Step 4: `manifest.json` anlegen**

```json
{
  "id": "vaultbridge",
  "name": "Vaultbridge",
  "version": "1.0.0",
  "minAppVersion": "1.4.0",
  "description": "Ende-zu-Ende-verschlüsseltes Vault-Sync gegen CouchDB mit Konflikt-Diff-Ansicht, Setup-String und Mobile-Support.",
  "author": "Markus Wenzel",
  "isDesktopOnly": false
}
```

- [ ] **Step 5: `versions.json` und `styles.css` anlegen**

`versions.json`:
```json
{ "1.0.0": "1.4.0" }
```

`styles.css`:
```css
/* Vaultbridge – Styles folgen in späteren Meilensteinen (Diff-View etc.) */
```

- [ ] **Step 6: `vitest.config.ts` und `test/setup.ts` anlegen**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
  },
});
```

`test/setup.ts`:
```ts
import { webcrypto } from "node:crypto";

// Node < 20 hat crypto nicht global; für WebCrypto-Tests sicherstellen.
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
```

- [ ] **Step 7: Platzhalter-`src/main.ts` und Smoke-Test anlegen**

`src/main.ts`:
```ts
import { Plugin } from "obsidian";

export default class VaultbridgePlugin extends Plugin {
  async onload(): Promise<void> {
    // Verdrahtung folgt in Task 6.
  }
}
```

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("führt Tests aus", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Abhängigkeiten installieren, Build und Test prüfen**

Run:
```bash
cd "23 obsidian-sync/vaultbridge"
npm install
npm run build
npm test
```
Expected: `npm run build` erzeugt `main.js` ohne Fehler; `npm test` meldet den Smoke-Test als PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: Projekt-Scaffold + Toolchain (esbuild, vitest, manifest)"
```

---

## Task 2: Kodier-Helfer (`crypto/encoding.ts`)

**Files:**
- Create: `src/crypto/encoding.ts`
- Test: `test/encoding.test.ts`

**Interfaces:**
- Consumes: nichts (nur `btoa`/`atob`/`TextEncoder`, überall verfügbar).
- Produces:
  - `bytesToBase64url(bytes: Uint8Array): string`
  - `base64urlToBytes(s: string): Uint8Array`
  - `bytesToHex(bytes: Uint8Array): string`
  - `utf8: { encode(s: string): Uint8Array; decode(b: Uint8Array): string }`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/encoding.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { bytesToBase64url, base64urlToBytes, bytesToHex, utf8 } from "../src/crypto/encoding";

describe("encoding", () => {
  it("base64url roundtrip (auch mit +// erzeugenden Bytes)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255, 62, 63]);
    const s = bytesToBase64url(bytes);
    expect(s).not.toMatch(/[+/=]/); // url-safe, kein Padding
    expect([...base64urlToBytes(s)]).toEqual([...bytes]);
  });

  it("utf8 roundtrip mit Umlauten", () => {
    const text = "Grüße äöü – Vault";
    expect(utf8.decode(utf8.encode(text))).toBe(text);
  });

  it("hex-Kodierung mit führenden Nullen", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/encoding.test.ts`
Expected: FAIL (Modul `../src/crypto/encoding` existiert nicht).

- [ ] **Step 3: Implementierung schreiben**

`src/crypto/encoding.ts`:
```ts
export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder().decode(b),
};
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/encoding.test.ts`
Expected: PASS (3 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/crypto/encoding.ts test/encoding.test.ts
git commit -m "feat: base64url/hex/utf8 Kodier-Helfer mit Tests"
```

---

## Task 3: Krypto-Kern (`crypto/crypto.ts`)

**Files:**
- Create: `src/crypto/crypto.ts`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Consumes: `utf8`, `bytesToHex` aus `crypto/encoding.ts`.
- Produces:
  - `interface VaultKeys { contentKey: CryptoKey; idKey: CryptoKey; vaultSalt: Uint8Array }`
  - `deriveKeys(passphrase: string, salt: Uint8Array, iterations?: number): Promise<VaultKeys>`
  - `encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array>`
  - `decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array>`
  - `pathId(idKey: CryptoKey, path: string): Promise<string>` (Format `"n:" + hex`)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/crypto.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveKeys, encryptBytes, decryptBytes, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";

const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe("crypto", () => {
  it("verschlüsselt und entschlüsselt einen Roundtrip", async () => {
    const keys = await deriveKeys("richtig-geheim", salt, 50000);
    const plaintext = utf8.encode("Vertraulicher Vault-Inhalt äöü");
    const blob = await encryptBytes(keys.contentKey, plaintext);
    expect(blob[0]).toBe(1); // Versions-Präfix
    expect(blob.length).toBeGreaterThan(1 + 12 + plaintext.length); // + GCM-Tag
    const back = await decryptBytes(keys.contentKey, blob);
    expect(utf8.decode(back)).toBe("Vertraulicher Vault-Inhalt äöü");
  });

  it("nutzt pro Verschlüsselung einen frischen IV (unterschiedliche Ciphertexte)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const p = utf8.encode("gleich");
    const a = await encryptBytes(keys.contentKey, p);
    const b = await encryptBytes(keys.contentKey, p);
    expect([...a]).not.toEqual([...b]);
  });

  it("scheitert kontrolliert bei falscher Passphrase (GCM-Tag)", async () => {
    const good = await deriveKeys("richtig", salt, 50000);
    const bad = await deriveKeys("falsch", salt, 50000);
    const blob = await encryptBytes(good.contentKey, utf8.encode("geheim"));
    await expect(decryptBytes(bad.contentKey, blob)).rejects.toBeTruthy();
  });

  it("erzeugt deterministische, aber pfadabhängige ids", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const id1 = await pathId(keys.idKey, "Ordner/Notiz.md");
    const id2 = await pathId(keys.idKey, "Ordner/Notiz.md");
    const id3 = await pathId(keys.idKey, "Ordner/Andere.md");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith("n:")).toBe(true);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/crypto.test.ts`
Expected: FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementierung schreiben**

`src/crypto/crypto.ts`:
```ts
import { utf8, bytesToHex } from "./encoding";

export interface VaultKeys {
  contentKey: CryptoKey; // AES-GCM
  idKey: CryptoKey;      // HMAC-SHA256
  vaultSalt: Uint8Array; // Salt für Chunk-Hashes (späterer Meilenstein)
}

const CRYPTO_VERSION = 1;

export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  iterations = 210000,
): Promise<VaultKeys> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const masterBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    masterBits,
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );
  const empty = new Uint8Array(0);
  const contentKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: empty, info: utf8.encode("vaultbridge:content") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: empty, info: utf8.encode("vaultbridge:id") },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const vaultSaltBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: empty, info: utf8.encode("vaultbridge:chunksalt") },
    hkdfKey,
    256,
  );
  return { contentKey, idKey, vaultSalt: new Uint8Array(vaultSaltBits) };
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = CRYPTO_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return out;
}

export async function decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob[0] !== CRYPTO_VERSION) {
    throw new Error(`Nicht unterstützte Krypto-Version: ${blob[0]}`);
  }
  const iv = blob.subarray(1, 13);
  const ct = blob.subarray(13);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

export async function pathId(idKey: CryptoKey, path: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", idKey, utf8.encode(path)));
  return "n:" + bytesToHex(mac);
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/crypto/crypto.ts test/crypto.test.ts
git commit -m "feat: Krypto-Kern (PBKDF2+HKDF Ableitung, AES-GCM, Pfad-HMAC)"
```

---

## Task 4: Setup-String-Codec (`setup/setupString.ts`)

**Files:**
- Create: `src/setup/setupString.ts`
- Test: `test/setupString.test.ts`

**Interfaces:**
- Consumes: `bytesToBase64url`, `base64urlToBytes`, `utf8` aus `crypto/encoding.ts`.
- Produces:
  - `interface SetupOptions { obfuscatePaths: boolean; chunkSize: number; gzip: boolean }`
  - `interface SetupPayload { v: 1; couchUrl: string; db: string; user: string; pass: string; kdfSalt: string; kdfIter: number; pp: "embedded" | "separate"; passphrase?: string; opts: SetupOptions }`
  - `encodeSetup(payload: SetupPayload): string`
  - `decodeSetup(str: string): SetupPayload` (wirft `Error` mit deutscher Meldung bei ungültigem String)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/setupString.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encodeSetup, decodeSetup, SetupPayload } from "../src/setup/setupString";

function samplePayload(overrides: Partial<SetupPayload> = {}): SetupPayload {
  return {
    v: 1,
    couchUrl: "https://couch.example:6984",
    db: "vault_abc",
    user: "sync",
    pass: "s3cret",
    kdfSalt: "AAECAwQFBgcICQoLDA0ODw",
    kdfIter: 210000,
    pp: "embedded",
    passphrase: "meine-passphrase",
    opts: { obfuscatePaths: true, chunkSize: 100000, gzip: true },
    ...overrides,
  };
}

describe("setupString", () => {
  it("encode/decode roundtrip", () => {
    const p = samplePayload();
    const str = encodeSetup(p);
    expect(str.startsWith("vbridge1:")).toBe(true);
    expect(decodeSetup(str)).toEqual(p);
  });

  it("toleriert umgebende Leerzeichen/Zeilenumbrüche", () => {
    const str = "  " + encodeSetup(samplePayload()) + "\n";
    expect(decodeSetup(str).db).toBe("vault_abc");
  });

  it("wirft bei falschem Präfix", () => {
    expect(() => decodeSetup("qsync1:abc")).toThrow(/Präfix/);
  });

  it("wirft bei beschädigter Nutzlast", () => {
    expect(() => decodeSetup("vbridge1:@@@nicht-base64@@@")).toThrow(/beschädigt|unvollständig/);
  });

  it("wirft bei fehlendem Pflichtfeld", () => {
    const p: any = samplePayload();
    delete p.couchUrl;
    const str = "vbridge1:" + btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => decodeSetup(str)).toThrow(/couchUrl/);
  });

  it("wirft bei eingebettetem Modus ohne Passphrase", () => {
    const p = samplePayload({ pp: "embedded", passphrase: undefined });
    const str = encodeSetup(p);
    expect(() => decodeSetup(str)).toThrow(/Passphrase/);
  });

  it("akzeptiert getrennten Modus ohne Passphrase", () => {
    const p = samplePayload({ pp: "separate", passphrase: undefined });
    expect(decodeSetup(encodeSetup(p)).pp).toBe("separate");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/setupString.test.ts`
Expected: FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementierung schreiben**

`src/setup/setupString.ts`:
```ts
import { bytesToBase64url, base64urlToBytes, utf8 } from "../crypto/encoding";

export interface SetupOptions {
  obfuscatePaths: boolean;
  chunkSize: number;
  gzip: boolean;
}

export interface SetupPayload {
  v: 1;
  couchUrl: string;
  db: string;
  user: string;
  pass: string;
  kdfSalt: string; // base64url
  kdfIter: number;
  pp: "embedded" | "separate";
  passphrase?: string;
  opts: SetupOptions;
}

const PREFIX = "vbridge1:";
const REQUIRED: (keyof SetupPayload)[] = [
  "couchUrl", "db", "user", "pass", "kdfSalt", "kdfIter", "pp", "opts",
];

export function encodeSetup(payload: SetupPayload): string {
  return PREFIX + bytesToBase64url(utf8.encode(JSON.stringify(payload)));
}

export function decodeSetup(str: string): SetupPayload {
  const s = str.trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error("Kein gültiger Vaultbridge-Setup-String: Präfix \"vbridge1:\" fehlt.");
  }
  let obj: any;
  try {
    obj = JSON.parse(utf8.decode(base64urlToBytes(s.slice(PREFIX.length))));
  } catch {
    throw new Error("Setup-String beschädigt: Nutzlast konnte nicht dekodiert werden.");
  }
  if (obj.v !== 1) {
    throw new Error(`Nicht unterstützte Setup-Version: ${obj.v}`);
  }
  for (const field of REQUIRED) {
    if (obj[field] === undefined) {
      throw new Error(`Setup-String unvollständig: Feld "${field}" fehlt.`);
    }
  }
  if (obj.pp === "embedded" && !obj.passphrase) {
    throw new Error("Setup-String: eingebetteter Modus, aber keine Passphrase enthalten.");
  }
  return obj as SetupPayload;
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/setupString.test.ts`
Expected: PASS (7 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/setupString.ts test/setupString.test.ts
git commit -m "feat: Setup-String-Codec (encode/decode/validate) mit Tests"
```

---

## Task 5: CouchDB-Verbindungsprüfung (`setup/connection.ts`)

**Files:**
- Create: `src/setup/connection.ts`
- Test: `test/connection.test.ts`

**Interfaces:**
- Consumes: nichts (nur `btoa` + injizierbares `fetch`).
- Produces:
  - `interface ConnectionResult { ok: boolean; step: "url" | "auth" | "db"; message: string }`
  - `testConnection(payload: { couchUrl: string; db: string; user: string; pass: string }, fetchFn?: typeof fetch): Promise<ConnectionResult>`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

`test/connection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { testConnection } from "../src/setup/connection";

const base = { couchUrl: "https://couch.example:6984/", db: "vault_abc", user: "u", pass: "p" };

function fakeFetch(map: Record<string, { status: number; ok?: boolean }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    for (const key of Object.keys(map)) {
      if (url.includes(key)) {
        const { status } = map[key];
        return { status, ok: status >= 200 && status < 300 } as Response;
      }
    }
    throw new Error("unerwartete URL: " + url);
  }) as unknown as typeof fetch;
}

describe("testConnection", () => {
  it("meldet Server-nicht-erreichbar", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.step).toBe("url");
  });

  it("meldet Auth-Fehler bei 401", async () => {
    const r = await testConnection(base, fakeFetch({ "6984/": { status: 401 } }));
    expect(r.ok).toBe(false);
    expect(r.step).toBe("auth");
  });

  it("meldet Erfolg, wenn DB noch nicht existiert (404)", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 404 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.step).toBe("db");
    expect(r.message).toMatch(/noch nicht/);
  });

  it("meldet vollen Erfolg, wenn DB existiert", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 200 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.step).toBe("db");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/connection.test.ts`
Expected: FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementierung schreiben**

`src/setup/connection.ts`:
```ts
export interface ConnectionResult {
  ok: boolean;
  step: "url" | "auth" | "db";
  message: string;
}

export async function testConnection(
  payload: { couchUrl: string; db: string; user: string; pass: string },
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionResult> {
  const authHeader = "Basic " + btoa(`${payload.user}:${payload.pass}`);
  const rootUrl = payload.couchUrl.replace(/\/$/, "") + "/";

  let root: Response;
  try {
    root = await fetchFn(rootUrl, { headers: { Authorization: authHeader } });
  } catch (e) {
    return { ok: false, step: "url", message: `Server nicht erreichbar: ${(e as Error).message}` };
  }
  if (root.status === 401 || root.status === 403) {
    return { ok: false, step: "auth", message: "Zugangsdaten abgelehnt (401/403). Benutzer/Passwort prüfen." };
  }
  if (!root.ok) {
    return { ok: false, step: "url", message: `Unerwartete Serverantwort: HTTP ${root.status}.` };
  }

  const dbUrl = payload.couchUrl.replace(/\/$/, "") + "/" + encodeURIComponent(payload.db);
  const db = await fetchFn(dbUrl, { headers: { Authorization: authHeader } });
  if (db.status === 404) {
    return { ok: true, step: "db", message: "Verbindung und Auth ok. Datenbank existiert noch nicht (wird beim ersten Sync angelegt)." };
  }
  if (!db.ok) {
    return { ok: false, step: "db", message: `Datenbank-Prüfung fehlgeschlagen: HTTP ${db.status}.` };
  }
  return { ok: true, step: "db", message: "Verbindung, Auth und Datenbank ok." };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/connection.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/connection.ts test/connection.test.ts
git commit -m "feat: CouchDB-Verbindungsprüfung mit injizierbarem fetch + Tests"
```

---

## Task 6: Selbsttest-Orchestrierung + Plugin-Verdrahtung

**Files:**
- Create: `src/setup/selfTest.ts`, `src/ui/SettingsTab.ts`
- Modify: `src/main.ts`
- Test: `test/selfTest.test.ts`

**Interfaces:**
- Consumes: `deriveKeys`, `encryptBytes`, `decryptBytes` (`crypto/crypto.ts`); `utf8`, `base64urlToBytes` (`crypto/encoding.ts`); `testConnection`, `ConnectionResult` (`setup/connection.ts`); `SetupPayload`, `decodeSetup` (`setup/setupString.ts`); Obsidian `Plugin`, `PluginSettingTab`, `Setting`, `Notice`.
- Produces:
  - `interface SelfTestResult { crypto: { ok: boolean; message: string }; connection: ConnectionResult }`
  - `runSelfTest(payload: SetupPayload, passphrase: string, fetchFn?: typeof fetch): Promise<SelfTestResult>`
  - `interface VaultbridgeSettings { setupString: string; deviceName: string }`
  - Plugin lädt/speichert Settings (`data.json`), zeigt Settings-Tab.

- [ ] **Step 1: Fehlschlagenden Test für `runSelfTest` schreiben**

`test/selfTest.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runSelfTest } from "../src/setup/selfTest";
import { SetupPayload } from "../src/setup/setupString";
import { bytesToBase64url } from "../src/crypto/encoding";

function payload(): SetupPayload {
  return {
    v: 1,
    couchUrl: "https://couch.example:6984",
    db: "vault_abc",
    user: "u",
    pass: "p",
    kdfSalt: bytesToBase64url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    kdfIter: 50000,
    pp: "embedded",
    passphrase: "pw",
    opts: { obfuscatePaths: true, chunkSize: 100000, gzip: true },
  };
}

const okFetch = (async (input: any) => {
  const url = String(input);
  const status = url.includes("vault_abc") ? 200 : 200;
  return { status, ok: true } as Response;
}) as unknown as typeof fetch;

describe("runSelfTest", () => {
  it("meldet Krypto-Roundtrip und Verbindung erfolgreich", async () => {
    const r = await runSelfTest(payload(), "pw", okFetch);
    expect(r.crypto.ok).toBe(true);
    expect(r.connection.ok).toBe(true);
  });

  it("Krypto-Teil ist unabhängig von der Verbindung erfolgreich", async () => {
    const failFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r = await runSelfTest(payload(), "pw", failFetch);
    expect(r.crypto.ok).toBe(true);
    expect(r.connection.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run test/selfTest.test.ts`
Expected: FAIL (Modul existiert nicht).

- [ ] **Step 3: `runSelfTest` implementieren**

`src/setup/selfTest.ts`:
```ts
import { deriveKeys, encryptBytes, decryptBytes } from "../crypto/crypto";
import { utf8, base64urlToBytes } from "../crypto/encoding";
import { testConnection, ConnectionResult } from "./connection";
import { SetupPayload } from "./setupString";

export interface SelfTestResult {
  crypto: { ok: boolean; message: string };
  connection: ConnectionResult;
}

const PROBE = "vaultbridge-selftest";

export async function runSelfTest(
  payload: SetupPayload,
  passphrase: string,
  fetchFn: typeof fetch = fetch,
): Promise<SelfTestResult> {
  let cryptoResult = { ok: false, message: "" };
  try {
    const keys = await deriveKeys(passphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
    const blob = await encryptBytes(keys.contentKey, utf8.encode(PROBE));
    const back = utf8.decode(await decryptBytes(keys.contentKey, blob));
    cryptoResult = back === PROBE
      ? { ok: true, message: "Verschlüsselungs-Roundtrip erfolgreich." }
      : { ok: false, message: "Roundtrip lieferte falsches Ergebnis." };
  } catch (e) {
    cryptoResult = { ok: false, message: `Krypto-Fehler: ${(e as Error).message}` };
  }

  const connection = await testConnection(payload, fetchFn);
  return { crypto: cryptoResult, connection };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run test/selfTest.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: Settings-Tab implementieren**

`src/ui/SettingsTab.ts`:
```ts
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultbridgePlugin from "../main";
import { decodeSetup } from "../setup/setupString";
import { runSelfTest } from "../setup/selfTest";

export class VaultbridgeSettingsTab extends PluginSettingTab {
  plugin: VaultbridgePlugin;

  constructor(app: App, plugin: VaultbridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vaultbridge" });

    new Setting(containerEl)
      .setName("Setup-String")
      .setDesc("Vom Administrator erzeugter String (beginnt mit \"vbridge1:\"). Wie ein Passwort behandeln.")
      .addTextArea((ta) => {
        ta.setPlaceholder("vbridge1:…")
          .setValue(this.plugin.settings.setupString)
          .onChange(async (value) => {
            this.plugin.settings.setupString = value.trim();
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 4;
        ta.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Gerätename")
      .setDesc("Name dieses Geräts im Sync.")
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Selbsttest")
      .setDesc("Prüft Verschlüsselung und CouchDB-Verbindung.")
      .addButton((b) =>
        b.setButtonText("Selbsttest ausführen").setCta().onClick(async () => {
          await this.runSelfTest();
        }),
      );
  }

  private async runSelfTest(): Promise<void> {
    let payload;
    try {
      payload = decodeSetup(this.plugin.settings.setupString);
    } catch (e) {
      new Notice(`Setup-String ungültig: ${(e as Error).message}`);
      return;
    }
    let passphrase = payload.passphrase ?? "";
    if (payload.pp === "separate") {
      passphrase = window.prompt("Passphrase eingeben:") ?? "";
      if (!passphrase) {
        new Notice("Selbsttest abgebrochen: keine Passphrase eingegeben.");
        return;
      }
    }
    new Notice("Selbsttest läuft …");
    const result = await runSelfTest(payload, passphrase);
    const cryptoIcon = result.crypto.ok ? "✅" : "❌";
    const connIcon = result.connection.ok ? "✅" : "❌";
    new Notice(
      `${cryptoIcon} Verschlüsselung: ${result.crypto.message}\n` +
        `${connIcon} Verbindung: ${result.connection.message}`,
      10000,
    );
  }
}
```

- [ ] **Step 6: `main.ts` verdrahten**

`src/main.ts`:
```ts
import { Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";

export interface VaultbridgeSettings {
  setupString: string;
  deviceName: string;
}

const DEFAULT_SETTINGS: VaultbridgeSettings = {
  setupString: "",
  deviceName: "",
};

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultbridgeSettingsTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

- [ ] **Step 7: Alle Tests + Build ausführen**

Run:
```bash
npm test
npm run build
```
Expected: alle Vitest-Dateien PASS; `main.js` wird ohne TypeScript-Fehler erzeugt.

- [ ] **Step 8: Manuelle Prüfung in Obsidian (Deliverable-Nachweis)**

1. Ordner `vaultbridge/` (mit `main.js`, `manifest.json`, `styles.css`) nach `<Test-Vault>/.obsidian/plugins/vaultbridge/` kopieren.
2. Obsidian → Einstellungen → Community-Plugins → „Vaultbridge" aktivieren.
3. Settings-Tab öffnen, einen mit dem Codec erzeugten Test-`vbridge1:`-String einfügen (z.B. per Node-REPL mit `encodeSetup` gegen eine lokale Docker-CouchDB).
4. „Selbsttest ausführen" → Notice zeigt ✅ Verschlüsselung und (bei laufender CouchDB) ✅ Verbindung.

Expected: Plugin lädt ohne Fehler; Selbsttest meldet Krypto-Erfolg und den korrekten Verbindungsstatus.

- [ ] **Step 9: Commit**

```bash
git add src/setup/selfTest.ts src/ui/SettingsTab.ts src/main.ts test/selfTest.test.ts
git commit -m "feat: Selbsttest-Orchestrierung + Settings-Tab + Plugin-Verdrahtung"
```

---

## Meilenstein-1-Abschluss

Nach Task 6 existiert ein installierbares, mobiltaugliches Plugin mit vollständig getesteten Krypto- und Setup-Bausteinen und einem sichtbaren Selbsttest. Damit ist das Fundament gelegt, auf dem die Sync-Engine aufsetzt.

---

## Roadmap: Folge-Meilensteine (je eigener Plan)

Diese werden nach Abschluss von M1 jeweils als eigener, ausführlicher Plan geschrieben (Spec-Referenz in Klammern):

- **M2 – Kern-Sync-Engine:** PouchDB einbinden, Dokumentmodell (Note/Chunk), Chunking + Dedup, `transform/`-Krypto-Schicht, `store/`, `replication/` (live/manuell, Backoff), `vault/`-Brücke mit Echo-Guard, Statusbar. Deliverable: echter verschlüsselter Zwei-Geräte-Sync. (Spec §4, §5, §7)
- **M3 – Konflikt-Diff-UI:** `conflicts/`-Erkennung + Auflöse-Logik (headless testbar), CodeMirror-Merge-View, Hunk-/Ganzdatei-Übernahme, Binärdatei-Karten. (Spec §8)
- **M4 – Dateisteuerung & Mobile-Feinschliff:** Regel-Editor (Include/Exclude-Globs), versteckte Dateien via Adapter, kuratierte Defaults; Mobile-Sync-Modi (WLAN-Gate, On-Open/Close), QR-Onboarding + Generator-Modal. (Spec §6, §9, §10)
- **M5 – Datei-Versionsverlauf:** `history/`-Modul, Verlauf-View, Wiederherstellung aus CouchDB-Revisionen. (Spec §11)
- **M6 – Passphrase-Rotation:** Epochen-Modell, abbrechbarer/fortsetzbarer Massen-Reencrypt, Geräte-Koordination. (Spec §5, höchstes Risiko — eigene, gründliche Tests)
- **M7 – Release-Reife:** GitHub-Actions-Release-Workflow, README (EN), `docs/server-setup.md` (Docker-Compose + CORS, Cloudant-Free-Tier), LICENSE, Community-Einreichungs-PR gegen `obsidianmd/obsidian-releases`. (Spec §15)
