export interface ListingAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/**
 * Läuft rekursiv durch den Vault-Baum und sammelt alle Dateipfade. Über
 * `shouldEnter` können ganze Ordner-Teilbäume übersprungen werden (z. B.
 * ausgeschlossene Ordner wie node_modules) — reines Perf-Hilfsmittel, es
 * ändert nichts an der Sync-Entscheidung der gelisteten Dateien.
 */
export async function listAllFiles(
  adapter: ListingAdapter,
  root = "",
  shouldEnter?: (folderPath: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const { files, folders } = await adapter.list(dir);
    out.push(...files);
    for (const folder of folders) {
      if (!shouldEnter || shouldEnter(folder)) stack.push(folder);
    }
  }
  return out;
}
