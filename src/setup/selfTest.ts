import { deriveKeys, encryptBytes, decryptBytes } from "../crypto/crypto";
import { utf8, base64urlToBytes } from "../crypto/encoding";
import { testConnection, ConnectionResult } from "./connection";
import { SetupPayload } from "./setupString";

export interface SelfTestResult {
  crypto: { ok: boolean; message: string };
  /** Browser-fetch — der Standardweg. */
  connection: ConnectionResult;
  /** Obsidians requestUrl — nur geprüft, wenn ein Adapter übergeben wurde. */
  connectionRequestUrl?: ConnectionResult;
}

const PROBE = "vaultbridge-selftest";

export async function runSelfTest(
  payload: SetupPayload,
  passphrase: string,
  // Pflichtparameter ohne Standardwert, damit das globale `fetch` nur an der
  // aufrufenden Stelle benannt wird. Erwartet wird dort das Browser-`fetch`: es
  // übt exakt den Pfad aus, den PouchDB im Normalbetrieb nimmt, inklusive
  // CORS-Preflight. Wird zusätzlich ein requestUrl-Adapter übergeben, wird der
  // zweite Weg separat geprüft — so sieht man auf einen Blick, ob ein Umstellen
  // der Verbindungsart hilft.
  fetchFn: typeof fetch,
  requestUrlFetch?: typeof fetch,
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
  const connectionRequestUrl = requestUrlFetch
    ? await testConnection(payload, requestUrlFetch)
    : undefined;
  return { crypto: cryptoResult, connection, ...(connectionRequestUrl ? { connectionRequestUrl } : {}) };
}
