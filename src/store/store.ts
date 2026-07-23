import { VaultKeys, pathId } from "../crypto/crypto";
import { encodeFile, decodeFile } from "./transform";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";
import { contentHash } from "../vault/applyChange";
import { MARKER_ID, EpochMarker } from "../crypto/rotation";

// Wandelt einen unbekannten Fehlerwert in ein Error-Objekt. Der unknown-Parameter
// verhindert, dass ein Truthy-Check den Wert auf {} verengt (Default-toString ->
// no-base-to-string); Originalfehler bleibt erhalten, falls bereits ein Error.
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export interface ConflictVersion {
  rev: string;
  bytes: Uint8Array;
  meta: FileMeta;
}

export interface FileRevision {
  rev: string;
  bytes: Uint8Array;
  meta: FileMeta;
}

export class VaultStore {
  // keyring[0] ist der AKTUELLE Schlüssel (für Kodierung/neue IDs), der Rest
  // sind Entschlüsselungs-Fallbacks aus früheren Rotationen. Variable Länge,
  // damit `rotate` bei Fortsetzen/frischem Salt niemals einen Schlüssel verliert.
  private keyring: VaultKeys[];

  constructor(
    private readonly db: PouchDB.Database,
    keys: VaultKeys,
    private readonly chunkSize: number,
    previousKeys: VaultKeys | null = null,
  ) {
    this.keyring = previousKeys ? [keys, previousKeys] : [keys];
  }

  /** Aktueller (vorderster) Schlüssel des Rings — alle bestehenden `this.keys`-Zugriffe bleiben so gültig. */
  private get keys(): VaultKeys {
    return this.keyring[0];
  }

  setKeys(current: VaultKeys, previous: VaultKeys | null = null): void {
    this.keyring = previous ? [current, previous] : [current];
  }

  /**
   * Versucht ein NoteDoc der Reihe nach mit jedem Schlüssel im Ring zu
   * entschlüsseln (aktuell zuerst, dann alle vorherigen). Während einer
   * Passphrase-Rotation (M6) können Docs noch mit einem älteren Schlüssel
   * verschlüsselt sein, bis sie neu geschrieben werden. Schlägt der ganze
   * Ring fehl -> null (kontrolliertes Überspringen).
   */
  private async tryDecode(
    note: NoteDoc,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null> {
    for (const k of this.keyring) {
      try {
        return await decodeFile(k, note, (cid) => this.db.get<ChunkDoc>(cid));
      } catch {
        /* falscher Schlüssel oder fehlender Chunk -> nächster Kandidat */
      }
    }
    return null;
  }

  async putFile(path: string, bytes: Uint8Array, meta: FileMeta): Promise<void> {
    const { note, chunks } = await encodeFile(this.keys, path, bytes, meta, this.chunkSize);

    // Chunks: nur neue schreiben (Dedup, Vermeidung unnötiger Revisions).
    await this.writeChunks(chunks);

    // Note: bestehende Revision übernehmen, damit ein Update kein Konflikt wird.
    const prev = await this.getRaw<NoteDoc>(note._id);
    if (prev) {
      note._rev = prev._rev;
    }
    await this.db.put(note);
  }

  async getFile(path: string): Promise<{ bytes: Uint8Array; meta: FileMeta } | null> {
    let note: (NoteDoc & { _rev: string }) | null = null;
    for (const k of this.keyring) {
      note = await this.getRaw<NoteDoc>(await pathId(k.idKey, path));
      if (note) break;
    }
    if (!note || note.deleted) return null;
    const decoded = await this.tryDecode(note);
    return decoded ? { bytes: decoded.bytes, meta: decoded.meta } : null;
  }

  async deleteFile(path: string): Promise<void> {
    const id = await pathId(this.keys.idKey, path);
    const note = await this.getRaw<NoteDoc>(id);
    if (!note) return;
    note.deleted = true;
    note.chunks = [];
    await this.db.put(note);
  }

  async listConflicts(): Promise<string[]> {
    const res = await this.db.allDocs({
      include_docs: true,
      conflicts: true,
      startkey: "n:",
      endkey: "n:￰",
    });
    const ids: string[] = [];
    for (const row of res.rows) {
      const doc = row.doc as (NoteDoc & { _conflicts?: string[] }) | undefined;
      if (doc && doc.type === "note" && doc._conflicts && doc._conflicts.length > 0) {
        ids.push(doc._id);
      }
    }
    return ids;
  }

  async readNote(
    id: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta; deleted: boolean } | null> {
    const note = await this.getRaw<NoteDoc>(id);
    if (!note) return null;
    const decoded = await this.tryDecode(note);
    if (!decoded) return null;
    return { path: decoded.path, bytes: decoded.bytes, meta: decoded.meta, deleted: !!note.deleted };
  }

  async readNoteRev(
    id: string,
    rev: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null> {
    try {
      const note = await this.db.get<NoteDoc>(id, { rev });
      return await this.tryDecode(note);
    } catch {
      return null;
    }
  }

  async listRevisions(id: string): Promise<FileRevision[]> {
    let revsInfo: { rev: string; status: string }[];
    try {
      const doc = await this.db.get<NoteDoc>(id, { revs_info: true });
      revsInfo = ((doc as unknown as { _revs_info?: { rev: string; status: string }[] })._revs_info) ?? [];
    } catch {
      return [];
    }
    const out: FileRevision[] = [];
    for (const entry of revsInfo) {
      if (entry.status !== "available") continue; // compaktierte/fehlende Revisionen überspringen
      const version = await this.readNoteRev(id, entry.rev);
      if (version) out.push({ rev: entry.rev, bytes: version.bytes, meta: version.meta });
    }
    return out; // PouchDB liefert revs_info von neu nach alt
  }

  async restoreRevision(id: string, rev: string): Promise<void> {
    const version = await this.readNoteRev(id, rev);
    if (!version) throw new Error("Revision nicht verfügbar (evtl. bereinigt).");
    await this.putFile(version.path, version.bytes, version.meta);
  }

  async getConflict(id: string): Promise<{
    id: string;
    path: string;
    isBinary: boolean;
    local: ConflictVersion;
    remotes: ConflictVersion[];
  } | null> {
    let winning: NoteDoc & { _rev: string; _conflicts?: string[] };
    try {
      winning = await this.db.get<NoteDoc>(id, { conflicts: true });
    } catch {
      return null;
    }
    if (!winning._conflicts || winning._conflicts.length === 0) return null;
    const local = await this.tryDecode(winning);
    if (!local) return null;
    const remotes: ConflictVersion[] = [];
    for (const rev of winning._conflicts) {
      const version = await this.readNoteRev(id, rev);
      if (version) remotes.push({ rev, bytes: version.bytes, meta: version.meta });
    }
    return {
      id,
      path: local.path,
      isBinary: local.meta.isBinary,
      local: { rev: winning._rev, bytes: local.bytes, meta: local.meta },
      remotes,
    };
  }

  async resolveConflict(
    id: string,
    path: string,
    mergedBytes: Uint8Array,
    meta: FileMeta,
    pruneRevs: string[],
  ): Promise<void> {
    const winning = await this.getRaw<NoteDoc>(id);
    const { note, chunks } = await encodeFile(this.keys, path, mergedBytes, { ...meta, size: mergedBytes.length }, this.chunkSize);
    await this.writeChunks(chunks);
    if (winning) note._rev = winning._rev;
    await this.db.put(note);
    let pruneError: unknown = null;
    for (const rev of pruneRevs) {
      try {
        await this.db.remove(id, rev);
      } catch (e) {
        const status = (e as { status?: number }).status;
        const name = (e as { name?: string }).name;
        if (status === 404 || name === "not_found") continue; // bereits entfernt -> ok
        pruneError = pruneError ?? e;
      }
    }
    if (pruneError) throw toError(pruneError);
  }

  async pathHashes(): Promise<Map<string, string>> {
    const res = await this.db.allDocs({ include_docs: true, startkey: "n:", endkey: "n:￰" });
    const map = new Map<string, string>();
    for (const row of res.rows) {
      const note = row.doc as (NoteDoc & { _rev: string }) | undefined;
      if (!note || note.type !== "note" || note.deleted) continue;
      const decoded = await this.tryDecode(note);
      if (!decoded) continue; // nicht entschlüsselbar (weder aktueller noch vorheriger Schlüssel) -> überspringen
      map.set(decoded.path, await contentHash(decoded.bytes));
    }
    return map;
  }

  /**
   * IDs aller Note-Docs (nur "n:", ohne Chunks/Marker). Grundlage für den
   * Store→Vault-Nachlauf (VaultBridge.reconcileFromStore): der Live-Feed
   * (subscribe, since:'now') materialisiert nur Änderungen AB Feed-Start —
   * bereits replizierte Docs (Reconnect/App-Neustart auf einem nur lesenden
   * Gerät) würden sonst nie in Dateien geschrieben.
   */
  async listNoteIds(): Promise<string[]> {
    const res = await this.db.allDocs({ startkey: "n:", endkey: "n:￰" });
    return res.rows.map((r) => r.id);
  }

  subscribe(onNoteChange: (id: string) => void): { cancel(): void } {
    const feed = this.db.changes({ live: true, since: "now", include_docs: false });
    void feed.on("change", (change) => {
      if (change.id.startsWith("n:")) onNoteChange(change.id);
    });
    return { cancel: () => feed.cancel() };
  }

  private async writeChunks(chunks: ChunkDoc[]): Promise<void> {
    for (const chunk of chunks) {
      if (!(await this.exists(chunk._id))) {
        try {
          await this.db.put(chunk);
        } catch (e) {
          // Ein 409 bedeutet: ein paralleler Schreibvorgang hat denselben
          // (inhaltsgleichen) Chunk bereits angelegt — genau das gewünschte
          // Dedup. Andere Fehler weiterreichen.
          const status = (e as { status?: number }).status;
          const name = (e as { name?: string }).name;
          if (status !== 409 && name !== "conflict") throw e;
        }
      }
    }
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await this.db.get(id);
      return true;
    } catch {
      return false;
    }
  }

  private async getRaw<T>(id: string): Promise<(T & { _rev: string }) | null> {
    try {
      return await this.db.get<T>(id);
    } catch {
      return null;
    }
  }

  async rotate(
    newKeys: VaultKeys,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.db.allDocs<NoteDoc>({ startkey: "n:", endkey: "n:￰", include_docs: true });
    const notes = res.rows
      .map((r) => r.doc)
      .filter((d): d is NoteDoc & { _rev: string } => !!d && d.type === "note" && !d.deleted);
    const total = notes.length;
    let done = 0;
    // Neuen Schlüssel voranstellen, ALLE bisherigen als Entschlüsselungs-Fallback behalten
    // (robust gegen Fortsetzen mit frischem Salt / verketteten Rotationen -> keine Verwaisung).
    if (this.keyring[0] !== newKeys) {
      this.keyring = [newKeys, ...this.keyring.filter((k) => k !== newKeys)];
    }
    for (const note of notes) {
      if (signal?.aborted) throw new Error("Rotation abgebrochen");
      // Schon mit dem neuen Schlüssel lesbar? -> überspringen (idempotent)
      let alreadyNew = false;
      try { await decodeFile(newKeys, note, (cid) => this.db.get<ChunkDoc>(cid)); alreadyNew = true; } catch { /* nein */ }
      if (!alreadyNew) {
        const decoded = await this.tryDecode(note);
        if (decoded) {
          const { note: newNote, chunks } = await encodeFile(newKeys, decoded.path, decoded.bytes, decoded.meta, this.chunkSize);
          await this.writeChunks(chunks);
          const prev = await this.getRaw<NoteDoc>(newNote._id);
          if (prev) newNote._rev = prev._rev;
          await this.db.put(newNote);
          if (newNote._id !== note._id) {
            try {
              await this.db.remove(note._id, note._rev);
            } catch (e) {
              const status = (e as { status?: number }).status;
              const name = (e as { name?: string }).name;
              if (status !== 404 && name !== "not_found") throw e;
            }
          }
        }
      }
      done++;
      onProgress?.(done, total);
    }
  }

  async readEpochMarker(): Promise<EpochMarker | null> {
    try { return (await this.db.get(MARKER_ID)) as unknown as EpochMarker; } catch { return null; }
  }
  async writeEpochMarker(marker: EpochMarker): Promise<void> {
    let rev: string | undefined;
    try { rev = ((await this.db.get(MARKER_ID)) as { _rev: string })._rev; } catch { /* neu */ }
    await this.db.put({ _id: MARKER_ID, ...(rev ? { _rev: rev } : {}), ...marker });
  }
}
