#!/usr/bin/env node
// Dev-/Test-Helfer: erzeugt einen Vaultbridge-Setup-String (vbridge1:...) für den
// manuellen Selbsttest in Obsidian. Der M4-Setup-Generator (mit QR) ersetzt das später.
//
// WICHTIG: Das Format muss mit src/setup/setupString.ts übereinstimmen
//   vbridge1:<base64url(JSON.stringify(payload))>
//
// Nutzung:
//   Interaktiv:      node scripts/make-setup-string.mjs   (oder: npm run make-setup)
//   Nicht-interaktiv (Env):
//     VB_URL=https://host:6984 VB_DB=vault_test VB_USER=admin VB_PASS=pw \
//     VB_PASSPHRASE=meine-passphrase node scripts/make-setup-string.mjs
//   Passphrase leer lassen  -> pp:"separate" (Passphrase wird im Plugin abgefragt).

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PREFIX = "vbridge1:";
const KDF_ITER = 210000;

function encodeSetup(payload) {
  // Node liefert mit 'base64url' bereits url-safe und ohne Padding -> identisch zu bytesToBase64url.
  return PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function collectInputs() {
  const fromEnv = {
    couchUrl: process.env.VB_URL,
    db: process.env.VB_DB,
    user: process.env.VB_USER,
    pass: process.env.VB_PASS,
    passphrase: process.env.VB_PASSPHRASE,
  };

  const haveRequired = fromEnv.couchUrl && fromEnv.db && fromEnv.user && fromEnv.pass;
  if (haveRequired) {
    return { ...fromEnv, passphrase: fromEnv.passphrase ?? "" };
  }

  if (!stdin.isTTY) {
    console.error(
      "Fehlende Angaben. Entweder interaktiv ausführen oder VB_URL/VB_DB/VB_USER/VB_PASS[/VB_PASSPHRASE] setzen.",
    );
    process.exit(2);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const couchUrl = (await rl.question("CouchDB-URL (z.B. https://host:6984): ")).trim();
    const db = (await rl.question("Datenbankname: ")).trim();
    const user = (await rl.question("Benutzer: ")).trim();
    const pass = (await rl.question("Passwort: ")).trim();
    const passphrase = (
      await rl.question("Verschlüsselungs-Passphrase (leer = getrennt/separate): ")
    ).trim();
    return { couchUrl, db, user, pass, passphrase };
  } finally {
    rl.close();
  }
}

const input = await collectInputs();
if (!input.couchUrl || !input.db || !input.user || !input.pass) {
  console.error("Abbruch: URL, Datenbank, Benutzer und Passwort sind Pflicht.");
  process.exit(2);
}

const embedded = input.passphrase.length > 0;
const payload = {
  v: 1,
  couchUrl: input.couchUrl,
  db: input.db,
  user: input.user,
  pass: input.pass,
  kdfSalt: randomBytes(16).toString("base64url"),
  kdfIter: KDF_ITER,
  pp: embedded ? "embedded" : "separate",
  ...(embedded ? { passphrase: input.passphrase } : {}),
  opts: { obfuscatePaths: true, chunkSize: 100000, gzip: true },
};

const setupString = encodeSetup(payload);

console.log("\n=== Vaultbridge Setup-String ===");
console.log(setupString);
console.log(`\nModus: ${payload.pp}${embedded ? "" : "  (Passphrase wird im Plugin separat abgefragt)"}`);
console.log("Wie ein Passwort behandeln — enthält Server-Zugangsdaten" + (embedded ? " und die Passphrase." : "."));
