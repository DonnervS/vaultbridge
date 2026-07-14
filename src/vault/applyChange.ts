import { bytesToHex } from "../crypto/encoding";

/**
 * Verhindert Endlosschleifen: eine gerade aus der Remote in den Vault
 * geschriebene Datei löst ein Obsidian-"modify"-Event aus — dieses darf nicht
 * als neue lokale Änderung zurück in den Store geschrieben werden.
 */
export class EchoGuard {
  private readonly pending = new Map<string, string>();

  markApplied(path: string, hash: string): void {
    this.pending.set(path, hash);
  }

  isEcho(path: string, hash: string): boolean {
    if (this.pending.get(path) === hash) {
      this.pending.delete(path); // einmalig konsumieren
      return true;
    }
    return false;
  }
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return bytesToHex(digest);
}

export function decideVaultAction(
  remote: { path: string; deleted: boolean },
  existsLocally: boolean,
): "write" | "delete" | "noop" {
  if (remote.deleted) return existsLocally ? "delete" : "noop";
  return "write";
}
