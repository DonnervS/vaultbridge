export interface FileMeta {
  mtime: number;
  ctime: number;
  size: number;
  mime: string;
  isBinary: boolean;
}

export interface NoteDoc {
  _id: string;
  _rev?: string;
  type: "note";
  path_enc: string;
  meta_enc: string;
  chunks: string[];
  deleted?: boolean;
}

export interface ChunkDoc {
  _id: string;
  _rev?: string;
  type: "chunk";
  data_enc: string;
}
