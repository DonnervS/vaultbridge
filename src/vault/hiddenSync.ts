export function planHiddenSync(
  local: Map<string, string>,
  known: Map<string, string>,
  store: Map<string, string>,
): { uploads: string[]; deleteRemotes: string[] } {
  const uploads: string[] = [];
  const deleteRemotes: string[] = [];
  const paths = new Set<string>([...local.keys(), ...known.keys()]);
  for (const path of paths) {
    const localHash = local.get(path);
    const knownHash = known.get(path);
    const storeHash = store.get(path);
    if (localHash === undefined) {
      // nicht mehr auf Platte
      if (knownHash !== undefined) deleteRemotes.push(path);
      continue;
    }
    if (localHash === storeHash) continue; // bereits in sync
    if (localHash !== knownHash) {
      uploads.push(path); // lokal geändert -> hochladen (ggf. Konflikt, M3 löst)
    }
    // sonst: lokal == known, aber != store -> Remote hat sich geändert -> Download übernimmt
  }
  return { uploads, deleteRemotes };
}
