export interface ConnectionResult {
  ok: boolean;
  step: "url" | "auth" | "db";
  message: string;
}

export async function testConnection(
  payload: { couchUrl: string; db: string; user: string; pass: string },
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionResult> {
  const authHeader = "Basic " + btoa(`${payload.user}:${payload.pass}`);
  const rootUrl = payload.couchUrl.replace(/\/$/, "") + "/";

  let root: Response;
  try {
    root = await fetchFn(rootUrl, { headers: { Authorization: authHeader } });
  } catch (e) {
    return { ok: false, step: "url", message: `Server nicht erreichbar: ${(e as Error).message}` };
  }
  if (root.status === 401 || root.status === 403) {
    return { ok: false, step: "auth", message: "Zugangsdaten abgelehnt (401/403). Benutzer/Passwort prüfen." };
  }
  if (!root.ok) {
    return { ok: false, step: "url", message: `Unerwartete Serverantwort: HTTP ${root.status}.` };
  }

  const dbUrl = payload.couchUrl.replace(/\/$/, "") + "/" + encodeURIComponent(payload.db);
  const db = await fetchFn(dbUrl, { headers: { Authorization: authHeader } });
  if (db.status === 404) {
    return { ok: true, step: "db", message: "Verbindung und Auth ok. Datenbank existiert noch nicht (wird beim ersten Sync angelegt)." };
  }
  if (!db.ok) {
    return { ok: false, step: "db", message: `Datenbank-Prüfung fehlgeschlagen: HTTP ${db.status}.` };
  }
  return { ok: true, step: "db", message: "Verbindung, Auth und Datenbank ok." };
}
