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
  // Ab dem LETZTEN "vbridge1:" lesen statt nur den Anfang zu prüfen: fängt den
  // häufigen Einfüge-Unfall ab, bei dem ein neuer String versehentlich an einen
  // alten gehängt wird ("…alterString\nvbridge1:neuerString") — dann gewinnt der
  // zuletzt eingefügte. Ignoriert außerdem vorangestellten Text.
  const idx = s.lastIndexOf(PREFIX);
  if (idx < 0) {
    throw new Error("Kein gültiger Vaultbridge-Setup-String: Präfix \"vbridge1:\" fehlt.");
  }
  // Alle Whitespaces aus der base64url-Nutzlast entfernen: ein durch einen
  // Zeilenumbruch zerrissener String (z. B. beim Einfügen in ein mehrzeiliges
  // Feld) soll trotzdem dekodieren. Das base64url-Alphabet enthält keinen
  // Whitespace, das Entfernen ist also verlustfrei.
  const raw = s.slice(idx + PREFIX.length).replace(/\s+/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(base64urlToBytes(raw)));
  } catch {
    throw new Error("Setup-String beschädigt: Nutzlast konnte nicht dekodiert werden.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Setup-String beschädigt: Nutzlast ist kein gültiges Objekt.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new Error(`Nicht unterstützte Setup-Version: ${String(obj.v)}`);
  }
  for (const field of REQUIRED) {
    if (obj[field] === undefined) {
      throw new Error(`Setup-String unvollständig: Feld "${field}" fehlt.`);
    }
  }
  if (obj.pp !== "embedded" && obj.pp !== "separate") {
    throw new Error(`Setup-String ungültig: unbekannter Passphrase-Modus "${String(obj.pp)}".`);
  }
  if (obj.pp === "embedded" && !obj.passphrase) {
    throw new Error("Setup-String: eingebetteter Modus, aber keine Passphrase enthalten.");
  }
  return obj as unknown as SetupPayload;
}
