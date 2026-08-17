import { VaultStore } from "./store";
import { FileMeta } from "./model";
import { contentHash } from "../vault/applyChange";

/**
 * Schlüssel für den Erst-Pull-Riegel (settings.initialPullDone). Bewusst
 * Server UND Datenbankname: derselbe Datenbankname auf einem anderen Server
 * ist ein anderer Datenbestand und braucht einen eigenen Erstabgleich.
 */
export function initialPullKey(couchUrl: string, db: string): string {
  return `${couchUrl.replace(/\/+$/, "")}/${db}`;
}

/**
 * Lädt eine lokale Datei nur hoch, wenn ihr INHALT vom Stand im Store
 * abweicht — Metadaten (mtime, Gerätename) unterscheiden sich zwischen zwei
 * Geräten immer und dürfen keinen Upload auslösen. Rückgabe: true = geschrieben.
 *
 * WICHTIG: Auf einem neuen Gerät muss der Store VOR dem ersten Aufruf per
 * Replikation gefüllt sein. Sonst meldet diese Funktion für jede Datei
 * "geändert", jede Datei bekommt lokal eine eigene Revision, und der
 * anschließende Pull macht daraus flächendeckend Konflikte. Genau das war der
 * Fehler bis 1.2.2 (VaultBridge.start() lief vor der Replikation).
 */
export async function uploadIfChanged(
  store: VaultStore,
  path: string,
  bytes: Uint8Array,
  meta: FileMeta,
): Promise<boolean> {
  const existing = await store.getFile(path);
  if (existing && (await contentHash(existing.bytes)) === (await contentHash(bytes))) {
    return false;
  }
  await store.putFile(path, bytes, meta);
  return true;
}
