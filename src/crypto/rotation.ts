import { VaultKeys, encryptBytes, decryptBytes } from "./crypto";
import { utf8, bytesToBase64url, base64urlToBytes } from "./encoding";

export const MARKER_ID = "vaultbridge:epoch";

export interface EpochMarker {
  epoch: number;
  kdfSalt: string;
  kdfIter: number;
  verify: string;
}

function tokenPlain(epoch: number): Uint8Array {
  return utf8.encode("vaultbridge-epoch-" + epoch);
}

export async function makeVerifyToken(keys: VaultKeys, epoch: number): Promise<string> {
  return bytesToBase64url(await encryptBytes(keys.contentKey, tokenPlain(epoch)));
}

export async function checkVerifyToken(keys: VaultKeys, epoch: number, token: string): Promise<boolean> {
  try {
    const plain = await decryptBytes(keys.contentKey, base64urlToBytes(token));
    return utf8.decode(plain) === "vaultbridge-epoch-" + epoch;
  } catch {
    return false;
  }
}

export function needsAdoption(localEpoch: number, marker: EpochMarker | null): boolean {
  return marker !== null && marker.epoch > localEpoch;
}
