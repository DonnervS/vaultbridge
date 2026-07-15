export function planPluginReload(changedPaths: string[]): string[] {
  const ids = new Set<string>();
  for (const path of changedPaths) {
    const m = path.match(/^\.obsidian\/plugins\/([^/]+)\//);
    if (m && m[1] !== "vaultbridge") ids.add(m[1]);
  }
  return [...ids];
}
