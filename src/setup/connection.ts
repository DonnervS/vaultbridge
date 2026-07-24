export interface ConnectionResult {
  ok: boolean;
  step: "url" | "auth" | "db";
  message: string;
}

export async function testConnection(
  payload: { couchUrl: string; db: string; user: string; pass: string },
  // Bewusst das Browser-`fetch` (nicht Obsidians `requestUrl`): Der Selbsttest
  // muss GENAU den Pfad prüfen, den PouchDB beim echten Sync nimmt — inklusive
  // CORS-Preflight. `requestUrl` umgeht CORS und würde den Test fälschlich grün
  // machen, während der spätere Sync dann an CORS scheitert. Nicht umstellen.
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionResult> {
  const authHeader = "Basic " + btoa(`${payload.user}:${payload.pass}`);
  const rootUrl = payload.couchUrl.replace(/\/$/, "") + "/";

  let root: Response;
  try {
    root = await fetchFn(rootUrl, { headers: { Authorization: authHeader } });
  } catch (e) {
    return { ok: false, step: "url", message: `Server nicht erreichbar: ${String(e)}` };
  }
  if (root.status === 401 || root.status === 403) {
    return { ok: false, step: "auth", message: "Zugangsdaten abgelehnt (401/403). Benutzer/Passwort prüfen." };
  }
  if (!root.ok) {
    return { ok: false, step: "url", message: `Unerwartete Serverantwort: HTTP ${root.status}.` };
  }
  // Bestätigen, dass hinter der URL wirklich die CouchDB-API sitzt: die Wurzel
  // liefert {"couchdb":"Welcome"}. Fängt den häufigsten Konfigurationsfehler ab,
  // die Fauxton-Weboberfläche (…/_utils) statt der Server-Wurzel einzutragen —
  // die antwortet mit HTTP 200 + HTML und würde sonst fälschlich als "ok"
  // durchgehen (der DB-Check darunter liefert dann 404 und meldete "DB wird
  // angelegt", also grün trotz falscher URL).
  let welcome: unknown;
  try {
    welcome = await root.json();
  } catch {
    welcome = null;
  }
  if (!welcome || (welcome as { couchdb?: unknown }).couchdb !== "Welcome") {
    return {
      ok: false,
      step: "url",
      message:
        "Antwort ist keine CouchDB-API. Zeigt die URL evtl. auf die Weboberfläche (…/_utils) statt auf die Server-Wurzel (z. B. http://host:5984)?",
    };
  }

  const dbUrl = rootUrl + encodeURIComponent(payload.db);
  let db: Response;
  try {
    db = await fetchFn(dbUrl, { headers: { Authorization: authHeader } });
  } catch (e) {
    return { ok: false, step: "db", message: `Datenbank nicht erreichbar: ${String(e)}` };
  }
  if (db.status === 401 || db.status === 403) {
    return { ok: false, step: "auth", message: "Zugangsdaten abgelehnt (401/403). Benutzer/Passwort prüfen." };
  }
  if (db.status === 404) {
    return { ok: true, step: "db", message: "Verbindung und Auth ok. Datenbank existiert noch nicht (wird beim ersten Sync angelegt)." };
  }
  if (!db.ok) {
    return { ok: false, step: "db", message: `Datenbank-Prüfung fehlgeschlagen: HTTP ${db.status}.` };
  }
  return { ok: true, step: "db", message: "Verbindung, Auth und Datenbank ok." };
}
