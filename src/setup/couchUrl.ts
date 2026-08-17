export interface UrlHint {
  level: "ok" | "warn" | "error";
  message: string;
}

export interface UrlCheck {
  hints: UrlHint[];
  /** Server-Wurzel ohne Pfad und ohne abschließenden Schrägstrich. */
  normalized: string;
}

const LOCAL_HOST =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[::1\]|.+\.local)$/i;

/** Adressen im eigenen Netz — genau die, die Chromiums Local Network Access sperrt. */
export function isLocalHostname(host: string): boolean {
  return LOCAL_HOST.test(host);
}

/**
 * Prüft die im Setup eingetragene CouchDB-URL und liefert verständliche
 * Hinweise. Absichtlich rein: dieselbe Prüfung läuft live beim Tippen im
 * Generator und lässt sich vollständig unit-testen.
 */
export function checkCouchUrl(raw: string): UrlCheck {
  const hints: UrlHint[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { hints, normalized: "" };

  if (!/^https?:\/\//i.test(trimmed)) {
    hints.push({
      level: "error",
      message: "Muss mit http:// oder https:// beginnen — z. B. http://192.168.20.30:5984",
    });
    return { hints, normalized: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    hints.push({ level: "error", message: "Das ist keine gültige URL." });
    return { hints, normalized: trimmed };
  }
  if (!url.hostname) {
    hints.push({ level: "error", message: "Es fehlt der Servername — z. B. http://192.168.20.30:5984" });
    return { hints, normalized: trimmed };
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (/^\/_utils/i.test(path)) {
    hints.push({
      level: "error",
      message:
        "Das ist Fauxton, die Weboberfläche von CouchDB. Hier gehört die Server-Wurzel hin — also ohne /_utils.",
    });
  } else if (path.length > 0) {
    hints.push({
      level: "error",
      message: `„${path.replace(/^\//, "")}" gehört nicht in die URL — der Datenbankname kommt in das Feld darunter.`,
    });
  }

  const local = isLocalHostname(url.hostname);
  if (url.protocol === "http:" && !url.port) {
    hints.push({ level: "warn", message: "Kein Port angegeben — CouchDB lauscht standardmäßig auf 5984." });
  }
  if (url.protocol === "http:" && !local) {
    hints.push({
      level: "warn",
      message: "Unverschlüsselt (http). Für den echten Betrieb einen Reverse-Proxy mit TLS davorschalten.",
    });
  }
  if (local) {
    hints.push({
      level: "warn",
      message:
        "Adresse im lokalen Netz. Blockiert Obsidian die Verbindung, stell in den Einstellungen die " +
        "Verbindungsart auf „Obsidian (requestUrl)\" um.",
    });
  }

  if (hints.length === 0) hints.push({ level: "ok", message: "Sieht gut aus." });
  return { hints, normalized: `${url.protocol}//${url.host}` };
}
