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
