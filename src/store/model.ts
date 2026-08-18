export interface FileMeta {
  mtime: number;
  ctime: number;
  size: number;
  mime: string;
  isBinary: boolean;
  // Anzeigename des Geräts, das diese Fassung geschrieben hat. Liegt in
  // meta_enc, ist also mitverschlüsselt — der Servereigentümer sieht keine
  // Gerätenamen. Optional: Dokumente aus 1.2.x haben das Feld nicht.
  device?: string;
  // Zeitpunkt des Schreibens nach der Uhr des schreibenden Geräts. Bewusst
  // NICHT mtime: reconcileHidden() schreibt für versteckte Dateien mtime 0,
  // dort gäbe es sonst nie einen Gewinner beim automatischen Auflösen.
  changedAt?: number;
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
