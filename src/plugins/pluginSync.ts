// Ermittelt aus geänderten Pfaden die betroffenen Plugin-Ids (ohne Vaultbridge
// selbst). Der Konfigordner ist bei Obsidian konfigurierbar (meist ".obsidian"),
// daher wird das Präfix aus dem echten configDir gebildet, nicht hartkodiert.
export function planPluginReload(changedPaths: string[], configDir = ".obsidian"): string[] {
  const ids = new Set<string>();
  const prefix = configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // Regex-Sonderzeichen escapen
  const re = new RegExp(`^${prefix}/plugins/([^/]+)/`);
  for (const path of changedPaths) {
    const m = path.match(re);
    if (m && m[1] !== "vaultbridge") ids.add(m[1]);
  }
  return [...ids];
}
