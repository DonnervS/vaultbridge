import { VaultKeys, pathId } from "../crypto/crypto";
import { encodeFile, decodeFile } from "./transform";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";
import { contentHash } from "../vault/applyChange";

export interface ConflictVersion {
  rev: string;
  bytes: Uint8Array;
  meta: FileMeta;
}

export class VaultStore {
  constructor(
    private readonly db: PouchDB.Database,
    private readonly keys: VaultKeys,
    private readonly chunkSize: number,
  ) {}

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
    const id = await pathId(this.keys.idKey, path);
    const note = await this.getRaw<NoteDoc>(id);
    if (!note || note.deleted) return null;
    const decoded = await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
    return { bytes: decoded.bytes, meta: decoded.meta };
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
    // decodeFile entschlüsselt path_enc/meta_enc immer; bei gelöschten Notes sind
    // chunks=[] -> bytes leer. path_enc/meta_enc bleiben beim Löschen erhalten.
    const decoded = await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
    return { path: decoded.path, bytes: decoded.bytes, meta: decoded.meta, deleted: !!note.deleted };
  }

  async readNoteRev(
    id: string,
    rev: string,
  ): Promise<{ path: string; bytes: Uint8Array; meta: FileMeta } | null> {
    try {
      const note = await this.db.get<NoteDoc>(id, { rev });
      return await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
    } catch {
      return null;
    }
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
    let local: Awaited<ReturnType<typeof decodeFile>>;
    try {
      local = await decodeFile(this.keys, winning, (cid) => this.db.get<ChunkDoc>(cid));
    } catch {
      return null;
    }
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
    if (pruneError) throw pruneError;
  }

  async pathHashes(): Promise<Map<string, string>> {
    const res = await this.db.allDocs({ include_docs: true, startkey: "n:", endkey: "n:￰" });
    const map = new Map<string, string>();
    for (const row of res.rows) {
      const note = row.doc as (NoteDoc & { _rev: string }) | undefined;
      if (!note || note.type !== "note" || note.deleted) continue;
      const decoded = await decodeFile(this.keys, note, (cid) => this.db.get<ChunkDoc>(cid));
      map.set(decoded.path, await contentHash(decoded.bytes));
    }
    return map;
  }

  subscribe(onNoteChange: (id: string) => void): { cancel(): void } {
    const feed = this.db.changes({ live: true, since: "now", include_docs: false });
    feed.on("change", (change) => {
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
      return (await this.db.get<T>(id)) as T & { _rev: string };
    } catch {
      return null;
    }
  }
}
