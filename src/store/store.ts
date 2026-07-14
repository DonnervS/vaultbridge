import { VaultKeys, pathId } from "../crypto/crypto";
import { encodeFile, decodeFile } from "./transform";
import { NoteDoc, ChunkDoc, FileMeta } from "./model";

export class VaultStore {
  constructor(
    private readonly db: PouchDB.Database,
    private readonly keys: VaultKeys,
    private readonly chunkSize: number,
  ) {}

  async putFile(path: string, bytes: Uint8Array, meta: FileMeta): Promise<void> {
    const { note, chunks } = await encodeFile(this.keys, path, bytes, meta, this.chunkSize);

    // Chunks: nur neue schreiben (Dedup, Vermeidung unnötiger Revisions).
    for (const chunk of chunks) {
      const exists = await this.exists(chunk._id);
      if (!exists) {
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
    const res = await this.db.allDocs({ include_docs: true, conflicts: true });
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

  subscribe(onNoteChange: (id: string) => void): { cancel(): void } {
    const feed = this.db.changes({ live: true, since: "now", include_docs: false });
    feed.on("change", (change) => {
      if (change.id.startsWith("n:")) onNoteChange(change.id);
    });
    return { cancel: () => feed.cancel() };
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
