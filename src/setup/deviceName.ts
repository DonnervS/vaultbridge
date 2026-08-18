/**
 * Plattform-Flags, wie Obsidians `Platform` sie liefert. Bewusst als Parameter
 * statt `import { Platform } from "obsidian"` — so bleibt dieses Modul unter
 * vitest testbar (dort gibt es kein "obsidian").
 */
export interface PlatformFlags {
  isMacOS: boolean;
  isWin: boolean;
  isIosApp: boolean;
  isAndroidApp: boolean;
  isTablet: boolean;
}

/**
 * Vorschlag für den Gerätenamen. Das Suffix ist Absicht: ohne es wären zwei
 * MacBooks in der Konfliktansicht nicht auseinanderzuhalten. Der Nutzer kann
 * den Namen in den Einstellungen jederzeit überschreiben.
 */
export function defaultDeviceName(p: PlatformFlags, suffix: string): string {
  // Mobil zuerst prüfen: auf iOS meldet Obsidian teilweise zusätzlich isMacOS.
  const base = p.isIosApp
    ? (p.isTablet ? "iPad" : "iPhone")
    : p.isAndroidApp
      ? "Android"
      : p.isMacOS
        ? "Mac"
        : p.isWin
          ? "Windows"
          : "Linux";
  return `${base}-${suffix}`;
}

/** Drei Hex-Zeichen zur Unterscheidung baugleicher Geräte. */
export function randomDeviceSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 3);
}
