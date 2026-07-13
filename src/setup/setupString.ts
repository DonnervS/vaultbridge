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
