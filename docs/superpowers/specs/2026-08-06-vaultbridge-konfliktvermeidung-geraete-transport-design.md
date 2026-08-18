# Vaultbridge v1.3 — Konfliktvermeidung, Gerätezuordnung, Verbindungsart

- **Datum:** 2026-08-06
- **Status:** Entwurf zur Abnahme
- **Autor:** Markus Wenzel (mit Claude Code)
- **Basiert auf:** [2026-07-13-vaultbridge-design.md](2026-07-13-vaultbridge-design.md)
- **Betrifft:** v1.2.2 → v1.3.0

---

## 1. Ausgangslage

Vier Probleme aus dem Praxisbetrieb:

1. **Ein neu hinzugefügtes Gerät erzeugt Konflikte auf praktisch jeder Datei**, obwohl die Inhalte identisch sind. Die vorhandene Sammel-Auflösung räumt das nicht sauber weg.
2. **Die Vergleichsansicht zeigt nicht, auf welchem Gerät die Abweichung entstanden ist** — man sieht „Aktuell (A)" und „Konflikt (B)" ohne Anhaltspunkt, welche Seite woher kommt.
3. **Auf einem MacBook scheitert die Anbindung an Chromiums Local Network Access.** Obsidian läuft dort auf Chrome 142; Requests von `app://obsidian.md` auf eine lokale IP werden blockiert. CouchDB sendet keinen `Access-Control-Allow-Private-Network`-Header — und selbst wenn, würde Chrome 142 ihn nicht mehr auswerten.
4. **Beim Setup fehlt Hilfe zur korrekten Schreibweise der CouchDB-URL.**

## 2. Ursachenanalyse

### 2.1 Phantom-Konflikte beim Erstabgleich

In `main.ts:192-238` startet `connect()` die Bridge (Zeile 221) **vor** der Replikation (Zeile 227):

```
connect()
  ├─ bridge.start()          ← Zeile 221
  │    └─ reconcileExisting()   läuft über ALLE lokalen Dateien
  │         └─ store.getFile()  fragt die NOCH LEERE lokale PouchDB
  │         └─ store.putFile()  → jede Datei bekommt lokal Revision 1-x
  └─ startSyncForMode()      ← Zeile 227
       └─ Pull liefert für dieselbe _id die Remote-Revision 1-y
            → CouchDB-Konflikt auf JEDER Datei
```

`reconcileExisting()` (`bridge.ts:112-126`) hat zwar bereits einen Hash-Vergleich gegen `store.getFile()` und ist damit im laufenden Betrieb idempotent — aber auf einem frischen Gerät ist der Store zum Vergleichszeitpunkt leer, der Vergleich läuft ins Leere und alles wird hochgeladen.

`reconcileHidden()` (`main.ts:231`, `bridge.ts:305`) trifft es genauso: die `known`-Map ist auf einem neuen Gerät leer, der Store noch nicht gefüllt, also gilt jede versteckte Datei als Upload-Kandidat.

Weil AES-GCM mit zufälligem IV verschlüsselt und `meta_enc` gerätespezifische `mtime`/`ctime` enthält, sind die beiden Dokumente selbst bei byteidentischem Dateiinhalt nie identisch. Der Konflikt ist also echt auf CouchDB-Ebene — nur inhaltlich bedeutungslos.

### 2.2 Warum die vorhandene Auflösung nicht reicht

`resolveIdenticalConflicts()` (`main.ts:639-673`) hat drei Lücken:

| Lücke | Fundstelle | Folge |
|---|---|---|
| Nur ein Konfliktzweig | `c.remotes.length === 1` | Bei drei Geräten bleibt alles liegen |
| Binärdateien ausgeschlossen | `!c.isBinary` | Anhänge/Bilder bleiben liegen |
| Schreibt eine neue Revision | `store.resolveConflict()` → `db.put()` | Neuer Churn; lösen zwei Geräte gleichzeitig auf, entsteht sofort der nächste Konflikt |

Dazu ist die Auflösung rein manuell (Befehl bzw. Button in der Konfliktliste).

### 2.3 Local Network Access

Chrome 142 macht Local Network Access (LNA) zum Standardverhalten und ersetzt damit das ältere Private-Network-Access-Modell. Der Unterschied ist entscheidend: PNA war ein **Server-Opt-in** über den Header `Access-Control-Allow-Private-Network`, LNA ist eine **Nutzer-Berechtigung** per Browser-Abfrage. Es gibt also keine Serverkonfiguration mehr, die das Problem löst — der fehlende Header ist ein Symptom, keine Ursache. In Obsidians Electron-Umgebung existiert keine Oberfläche für diese Berechtigungsabfrage, deshalb schlägt der Request wortlos fehl.

Obsidians `requestUrl` läuft nicht im Renderer: auf dem Desktop geht es durch den Electron-Main-Prozess, auf Mobil durch die native Bridge. Beide Wege unterliegen weder CORS noch LNA.

### 2.4 URL-Eingabe

Der Generator (`GeneratorModal.ts:48-52`) bietet nur ein Textfeld mit Platzhalter `https://couch.example.com`, ohne Beispiel für Port, ohne Hinweis, dass der Datenbankname **nicht** in die URL gehört. `testConnection()` (`connection.ts:30-49`) fängt den `/_utils`-Fehler bereits ab — aber erst nach dem Erzeugen des Setup-Strings und nur, wenn man den Selbsttest überhaupt findet.

## 3. Lösung

### 3.1 Erst-Pull vor Erst-Upload

**Änderung in `main.ts:connect()`** — Reihenfolge umgekehrt:

1. Store, Bridge-Objekt und Remote-DB anlegen (wie bisher).
2. `bridge.start()` registriert die Vault-Listener **sofort**, führt aber weder `reconcileExisting()` noch `reconcileHidden()` aus. Lokale Datei-Events werden in einer Warteschlange gepuffert.
3. Einmaliger Pull (`PouchDB.replicate.from(remote)`) bis `complete`. Statusleiste: „Erstabgleich …".
4. `settings.initialPullDone[dbName] = true`, speichern.
5. `bridge.runInitialUpload()` — arbeitet die gepufferte Warteschlange ab, dann `reconcileExisting()` und `reconcileHidden()`.
6. `startSyncForMode()` wie bisher.

**Riegel über Neustarts:** Neues Settings-Feld `initialPullDone: Record<string, boolean>`. Schlüssel ist `couchUrl + "/" + db` aus dem Setup-String, nicht der Datenbankname allein — sonst würde derselbe Name auf einem anderen Server fälschlich als „schon abgeglichen" gelten. Der Erst-Upload läuft erst, wenn für diesen Schlüssel mindestens einmal ein vollständiger Pull durchgelaufen ist. Startet Obsidian offline, wird nichts hochgeladen — die Dateien liegen lokal ohnehin sicher, und beim nächsten erfolgreichen Verbinden holt der Abgleich alles nach. Ist die Remote leer (erstes Gerät überhaupt), ist der Pull sofort fertig und der Upload läuft normal.

**Warum die Warteschlange:** Ohne sie gingen Bearbeitungen während des Erst-Pulls entweder verloren (Listener später registrieren) oder erzeugten genau den Konflikt, den wir vermeiden wollen (Listener aktiv, Store noch leer). Gepuffert wird der Pfad, nicht der Inhalt — nach dem Pull wird die Datei frisch gelesen und ganz normal durch `onLocalWrite` geschickt.

**Verhalten bei Pull-Fehler:** Schlägt der Pull fehl (offline, falsche Zugangsdaten), bleibt `initialPullDone` unverändert, Schritt 5 entfällt, Schritt 6 läuft trotzdem — man kann offline weiterarbeiten. Nachgeholt wird in `onSyncStatus`: bei `idle`/`paused` ohne Fehler und noch nicht gesetztem `initialPullDone` wird die Flagge gesetzt und `runInitialUpload()` angestoßen. Ein erfolgreich abgeschlossener Live-Sync-Zyklus ist derselbe Nachweis wie ein abgeschlossener Einzel-Pull, also braucht es keinen zweiten Sonderweg.

### 3.2 Automatische Konfliktauflösung

**Neues Modul `src/conflicts/autoResolve.ts`** — reine Logik ohne PouchDB-Abhängigkeit, damit vollständig unit-testbar:

```ts
export interface ConflictBranch {
  rev: string;
  hash: string;        // SHA-256 der ENTSCHLÜSSELTEN Bytes
  changedAt: number;   // aus FileMeta, 0 wenn unbekannt
  deleted: boolean;
}

export type AutoResolvePlan =
  | { kind: "identical";   keep: string; prune: string[] }
  | { kind: "newest-wins"; keep: string; prune: string[]; loser: ConflictBranch }
  | null;                  // nichts zu tun

export function planAutoResolve(
  winner: ConflictBranch,
  others: ConflictBranch[],
): AutoResolvePlan;
```

**Regel 1 — inhaltsgleich.** Haben alle Zweige denselben `hash` und dasselbe `deleted`-Flag, ist der Konflikt bedeutungslos. `keep` = der CouchDB-Gewinner, `prune` = alle anderen. Es wird **nichts geschrieben**, nur `db.remove(id, rev)` für die Verlierer. Das ist der wesentliche Unterschied zur heutigen Implementierung: kein neues Dokument, kein Churn, idempotent — und weil CouchDBs Gewinnerwahl deterministisch ist, kommen alle Geräte unabhängig voneinander zum selben Ergebnis. Gilt für Text **und** Binärdateien und für beliebig viele Zweige. Läuft still, ohne Meldung.

**Regel 2 — echte Abweichung.** Gewinner ist der Zweig mit dem größten `changedAt`. Bei Gleichstand entscheidet die lexikographisch größte Revision — exakt der Tiebreaker, den CouchDB selbst verwendet, also wieder geräteübergreifend dasselbe Ergebnis. Zweige, die byteidentisch zum Gewinner sind, wandern trotzdem nach `prune`. Der eigentliche Verlierer wird gemeldet und als Sidecar gesichert.

Ist der so bestimmte Gewinner **nicht** der CouchDB-Gewinner, reicht Pruning nicht — sein Inhalt muss in den Hauptzweig geschrieben werden. Dieser Fall läuft über das bestehende `resolveConflict()` (Neuschreiben plus Pruning). Ist er identisch mit dem CouchDB-Gewinner, genügt wie bei Regel 1 das reine `pruneConflictRevs()`.

**Neues Feld `changedAt` in `FileMeta`** statt der Datei-`mtime`. Zwei Gründe: `reconcileHidden()` schreibt für versteckte Dateien `mtime: 0` (`bridge.ts:355`), dort gäbe es nie einen Gewinner; und `mtime`-Werte aus fremden Dateisystemen sind ohnehin nicht verlässlich vergleichbar. `changedAt` wird beim Schreiben aus der Uhr des schreibenden Geräts gesetzt.

**Ausführung** in `main.ts`, neue Methode `autoResolveConflicts()`, aufgerufen aus `refreshConflicts()`:

- Gated auf `initialPullDone` — während des Erstabgleichs darf nichts aufgelöst werden.
- Reentrancy-Guard analog `checkingAdoption`, damit zwei Settles nicht gleichzeitig auflösen.
- Bei `kind: "newest-wins"`: die Verlierer-Bytes als `<pfad>.vaultbridge-konflikt` in den Vault schreiben (gleicher Mechanismus wie `bridge.ts:220`), dann `Notice` mit Dateiname und beiden Gerätenamen.
- Fehler pro Datei werden übersprungen, nicht abgebrochen.

**Neue Store-Methode `pruneConflictRevs(id, revs)`** — verwirft Revisionen ohne Neuschreiben, `404` gilt als Erfolg (bereits entfernt). `resolveConflict()` bleibt für den manuellen Weg und für Regel 2 unverändert.

Der Button „Identische auflösen" und der Befehl bleiben für manuelles Nachfassen erhalten, nutzen aber intern denselben Planer.

### 3.3 Gerätezuordnung

**`FileMeta` erweitern** — beide Felder optional, damit bestehende Dokumente ohne Migration lesbar bleiben:

```ts
export interface FileMeta {
  mtime: number;
  ctime: number;
  size: number;
  mime: string;
  isBinary: boolean;
  device?: string;      // Anzeigename des schreibenden Geräts
  changedAt?: number;   // Date.now() beim Schreiben
}
```

Beide liegen in `meta_enc` und sind damit mitverschlüsselt — der Servereigentümer sieht keine Gerätenamen.

**`settings.deviceName` wird endlich benutzt.** Heute wird er gesetzt (`SettingsTab.ts:75`), aber nirgends gelesen, und der Standard ist leer. Beim ersten `connect()` wird er vorbelegt, wenn leer: Plattformkürzel plus dreistelliges Zufallssuffix — `Mac-7f3`, `Windows-a12`, `iPhone-4c8`, `Android-9d1`, `Linux-b04`. Ohne Suffix wären zwei MacBooks nicht unterscheidbar. Ermittelt aus `Platform.isMacOS`/`isWin`/`isIosApp`/`isAndroidApp` (keine Node-APIs — Mobile-Kompatibilität). In den Einstellungen umbenennbar; die Beschreibung erklärt jetzt, wozu der Name dient.

**Anzeige an vier Stellen:**

- **Kopfzeile der Diff-View** — „Geändert auf Mac-7f3 (A) und Windows-a12 (B)" statt des heutigen anonymen Hinweistexts. Bei mehr als zwei Zweigen werden alle beteiligten Geräte genannt.
- **Spaltenköpfe des Side-by-Side-Diffs** (`ConflictDiffView.ts:186-187`) — `Aktuell (A) · Mac-7f3 · 6. Aug. 2026, 14:23`.
- **Binär-Karten** (`ConflictDiffView.ts:231-242`) — Gerät und Zeitstempel zusätzlich zur Bytegröße. Bei Binärdateien ist das die einzige Entscheidungsgrundlage überhaupt.
- **Konfliktliste** (`ConflictListView.ts:53-66`) — Zeile `Mac-7f3 ↔ Windows-a12` unter dem Dateinamen.

**Fallback** für Dokumente ohne `device`: „Gerät unbekannt". Zeitstempel wird nur angezeigt, wenn `changedAt` gesetzt ist; sonst ersatzweise `mtime`, sofern ungleich 0.

Der Diff selbst vergleicht weiterhin A gegen den ersten Konfliktzweig.

### 3.4 Hilfe zur CouchDB-URL

**Neues Modul `src/setup/couchUrl.ts`** — reine Funktion, voll testbar:

```ts
export interface UrlHint { level: "ok" | "warn" | "error"; message: string }
export function checkCouchUrl(raw: string): { hints: UrlHint[]; normalized: string }
```

Geprüft wird:

| Eingabe | Stufe | Meldung |
|---|---|---|
| `192.168.20.30:5984` | error | Muss mit `http://` oder `https://` beginnen |
| `http://host:5984/vault` | error | Datenbankname gehört ins eigene Feld darunter, nicht in die URL |
| `http://host:5984/_utils` | error | Das ist Fauxton, die Weboberfläche. Die API-Wurzel ist `http://host:5984` |
| `http://host:5984/` | ok | Abschließender Schrägstrich wird entfernt |
| `http://192.168.20.30` | warn | Ohne Port — CouchDB lauscht standardmäßig auf 5984 |
| `http://` auf öffentlichem Host | warn | Unverschlüsselt; für echte Nutzung TLS davorschalten |
| `http://` auf lokaler Adresse | warn | Hinweis auf die Verbindungsart-Einstellung (§3.5) |

Erkennung lokaler Adressen: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `localhost`, `*.local`.

**Im Generator-Modal** (`GeneratorModal.ts`):

- Feldbeschreibung mit konkretem Beispiel: `https://couch.example.com` oder `http://192.168.20.30:5984` — ohne Datenbanknamen, ohne `/_utils`, ohne abschließenden Schrägstrich.
- Live-Feedback unter dem Feld beim Tippen, farblich nach Stufe.
- Neuer Button „Verbindung testen" direkt im Generator (nutzt `testConnection`), damit man nicht erst den Setup-String erzeugen und dann den Selbsttest suchen muss.

### 3.5 Verbindungsart

**Neue Einstellung `transport: "fetch" | "requestUrl"`, Standard `"fetch"`.** Laufende Installationen behalten den bisherigen Weg mit Streaming unverändert — er funktioniert gut, und ein automatischer Wechsel wäre unnötiges Regressionsrisiko.

**Neues Modul `src/store/obsidianFetch.ts`** — ein `fetch`-kompatibler Adapter auf Basis von Obsidians `requestUrl`, der als `{ fetch }`-Option an die Remote-PouchDB übergeben wird. Zu beachten:

- `requestUrl` puffert die Antwort vollständig; PouchDBs Live-Replikation nutzt `_changes?feed=longpoll`, das ist ein abgeschlossener Response-Body und damit kompatibel.
- Rückgabe muss ein `Response`-artiges Objekt sein: `ok`, `status`, `headers`, `json()`, `text()`, `arrayBuffer()`.
- `throw: false` setzen, damit HTTP-Fehlerstatus nicht als Exception kommen, sondern als `Response` mit `ok: false` — PouchDB wertet Statuscodes selbst aus.
- Nur der **Remote**-PouchDB wird der Adapter untergeschoben; die lokale IndexedDB-Instanz bleibt unberührt.

**Hinweistext in den Einstellungen**, direkt bei der Verbindungsart:

> **Verbindung wird blockiert?** Chrome 142 — die Grundlage aktueller Obsidian-Versionen — verlangt eine Berechtigung, bevor eine App auf Adressen im lokalen Netz zugreifen darf (`192.168.…`, `10.…`, `localhost`). Obsidian hat für diese Abfrage keine Oberfläche, deshalb schlägt die Verbindung ohne Erklärung fehl. Am Server lässt sich das nicht beheben: der früher übliche Header `Access-Control-Allow-Private-Network` wird von Chrome 142 nicht mehr ausgewertet. Stell in diesem Fall die Verbindungsart auf **Obsidian (requestUrl)** — damit läuft der Sync an dieser Sperre vorbei.

**Selbsttest prüft beide Wege.** Heute testet `testConnection()` bewusst nur das Browser-`fetch`, damit CORS-Probleme nicht verschleiert werden (`connection.ts:9-13`) — diese Ehrlichkeit bleibt. Neu wird zusätzlich der `requestUrl`-Weg geprüft und beides einzeln gemeldet:

```
✅ Verschlüsselung: ok
❌ Browser (fetch): blockiert — Local Network Access?
✅ Obsidian (requestUrl): Verbindung, Auth und Datenbank ok
→ Stell die Verbindungsart auf „Obsidian (requestUrl)" um.
```

**`docs/server-setup.md`** bekommt einen Abschnitt „Local Network Access (Chrome 142+)" im Troubleshooting mit demselben Inhalt auf Englisch.

## 4. Betroffene Dateien

**Neu**

| Datei | Zweck |
|---|---|
| `src/conflicts/autoResolve.ts` | Planungslogik für automatische Auflösung |
| `src/setup/couchUrl.ts` | URL-Prüfung und -Normalisierung |
| `src/store/obsidianFetch.ts` | `fetch`-Adapter auf Basis von `requestUrl` |
| `test/autoResolve.test.ts` | Unit-Tests Regel 1 + 2, Tiebreaker, Mehrfachzweige |
| `test/couchUrl.test.ts` | Unit-Tests aller Prüfregeln |
| `test/initialPull.test.ts` | Integrationstest: neues Gerät erzeugt keine Konflikte |

**Geändert**

| Datei | Änderung |
|---|---|
| `src/main.ts` | Reihenfolge in `connect()`, `initialPullDone`, `autoResolveConflicts()`, `transport`, Gerätename-Vorbelegung |
| `src/vault/bridge.ts` | Erst-Upload-Gate, Event-Warteschlange, `device`/`changedAt` in `metaOf()` und `reconcileHidden()` |
| `src/store/model.ts` | `FileMeta` um `device?` und `changedAt?` erweitert |
| `src/store/store.ts` | `pruneConflictRevs()` |
| `src/ui/ConflictDiffView.ts` | Gerät und Zeitstempel in Kopf, Spaltenköpfen, Binär-Karten |
| `src/ui/ConflictListView.ts` | Gerätezeile pro Eintrag |
| `src/ui/SettingsTab.ts` | Verbindungsart mit Hinweistext, Gerätename-Beschreibung |
| `src/ui/GeneratorModal.ts` | URL-Hilfe, Live-Prüfung, „Verbindung testen" |
| `src/setup/connection.ts` | `testConnection` transport-fähig |
| `src/setup/selfTest.ts` | beide Transportwege prüfen und einzeln melden |
| `styles.css` | Klassen für Gerätezeile und URL-Hinweise |
| `docs/server-setup.md` | Abschnitt Local Network Access |
| `README.md` | Kurzhinweis Verbindungsart |
| `manifest.json`, `package.json`, `versions.json` | Version 1.3.0 |

## 5. Tests

**Unit**

- `planAutoResolve`: alle Zweige gleich → `identical`; ein Zweig abweichend → `newest-wins` mit korrektem Gewinner; `changedAt`-Gleichstand → lexikographisch größte Revision gewinnt; drei Zweige, zwei davon identisch → beide identischen geprunt, abweichender entscheidet; `deleted`-Flag unterschiedlich bei gleichem Hash → **kein** `identical`.
- `checkCouchUrl`: jede Zeile der Tabelle in §3.4 als eigener Fall; Normalisierung (Whitespace, Schrägstrich); IPv6-Literale werden nicht fälschlich als Pfad gelesen.
- `obsidianFetch`: Statuscode-Weitergabe bei `throw: false`; Header-Zugriff case-insensitive; `arrayBuffer()` liefert exakte Bytes.

**Integration** (`test/initialPull.test.ts`, Memory-Adapter wie in `conflictIntegration.test.ts`)

- Zwei Stores mit identischem Inhalt, Gerät B verbindet neu → nach Erst-Pull und Erst-Upload gilt `listConflicts().length === 0`. Dieser Test schlägt gegen den heutigen Code fehl und ist der eigentliche Nachweis für §3.1.
- Gerät B ändert eine Datei während des Erst-Pulls → Änderung ist nach dem Abgleich im Store, kein Konflikt.
- Beide Geräte ändern dieselbe Datei unterschiedlich → genau ein Konflikt, `newest-wins` greift, Sidecar existiert.

**Manuell**

- MacBook mit Chrome-142-Obsidian gegen CouchDB auf lokaler IP: Selbsttest meldet `fetch` blockiert und `requestUrl` ok; nach Umstellung läuft der Sync.

## 6. Umsetzungsreihenfolge

1. **§3.1 Erst-Pull vor Erst-Upload** — behebt die Ursache, jede weitere Stufe profitiert davon.
2. **§3.2 Automatische Auflösung** — räumt den Bestand auf, der bereits entstanden ist. Braucht `changedAt` aus §3.3.
3. **§3.3 Gerätezuordnung** — Feld wird schon in Stufe 2 geschrieben, hier kommt die Anzeige dazu.
4. **§3.4 URL-Hilfe** und **§3.5 Verbindungsart** — unabhängig vom Rest, gemeinsam als Setup-Verbesserung.

Jede Stufe ist für sich lauffähig, testbar und einzeln releasebar.

## 7. Bewusst nicht enthalten

- **Kein automatischer Transport-Wechsel.** Der Selbsttest sagt, was zu tun ist; umgestellt wird von Hand. Ein Automatismus würde bei funktionierenden Installationen den Transport unter der Hand wechseln.
- **Keine Drei-Wege-Zusammenführung** bei `newest-wins`. Der Verlierer wird als Sidecar gesichert, nicht gemergt — automatisches Zusammenführen ohne Nutzerblick ist zu riskant.
- **Keine Migration bestehender Dokumente** auf `device`/`changedAt`. Alte Dokumente zeigen „Gerät unbekannt", bis sie das nächste Mal geschrieben werden.
- **Keine Uhrensynchronisation.** `changedAt` ist die Uhr des schreibenden Geräts. Bei stark abweichenden Uhren kann `newest-wins` die „falsche" Seite wählen — deshalb der Sidecar und die Meldung.
