# Vaultbridge — Design-Spec

- **Datum:** 2026-07-13
- **Status:** Entwurf zur Abnahme
- **Autor:** Markus Wenzel (mit Claude Code)
- **Projekt:** Vaultbridge — ein Obsidian-Sync-Plugin (PouchDB ↔ CouchDB, Ende-zu-Ende-verschlüsselt)

---

## 1. Zweck & Ziele

Vaultbridge ist ein Obsidian-Community-Plugin, das einen Vault Ende-zu-Ende-verschlüsselt zwischen mehreren Geräten (Desktop + Mobile) über eine selbst gewählte CouchDB synchronisiert. Es baut konzeptionell auf dem bestehenden „qeridoo-sync"-Prototyp auf (PouchDB ↔ CouchDB, AES-GCM, Ein-String-Setup), ersetzt ihn aber durch eine frische, offene, wartbare TypeScript-Codebasis mit deutlich stärkeren Profi-Funktionen.

### Kernziele

1. **Einfache Anbindung** — Onboarding über einen einzigen Setup-String (plus optionalem QR-Code fürs Handy). Der String bleibt das Herzstück.
2. **Sichere Ende-zu-Ende-Verschlüsselung** — Server/DB-Admin sieht niemals Klartext, auch keine Datei­namen/Pfade.
3. **Konflikt-Diff-UI** — zweispaltige Gegenüberstellung lokal ↔ remote mit Übernahme einzeln (pro Änderungsblock) oder ganze Datei.
4. **Mobile-Support** — iOS/iPadOS und Android.
5. **Steuerbare Fremddateien** — `.claude/`, `.obsidian/plugins/` u.a. per Include/Exclude-Regeln ein-/ausschließbar.
6. **Community-tauglich** — GitHub-Repo ohne eigene Daten/Telemetrie, konform zu den Obsidian-Richtlinien.

### Nicht-Ziele (v1)

- Kein eigener gehosteter Dienst, keine Registrierung, keine Telemetrie.
- Kein Postgres/Supabase-Backend (bewusst verworfen zugunsten des erprobten CouchDB-Replikationsprotokolls).
- Kein Mehrbenutzer-Rechtemodell innerhalb eines Vaults (ein Vault = ein geteilter Schlüssel).
- Keine Echtzeit-Kollaboration im selben Dokument (Google-Docs-Stil). Sync ist dateibasiert.

---

## 2. Ausgangslage: Analyse des qeridoo-Prototyps

Der vorhandene `qeridoo-sync`-Build (bundled `main.js`, 142 KB) zeigt:

- **Architektur:** PouchDB im Client, Replikation gegen CouchDB über das native Protokoll (`_changes`, `_bulk_docs`, `_revs_diff`, `_local`, Revision-Trees). PouchDB-Fehlerstrings sind im Bundle nachweisbar.
- **Verschlüsselung:** AES-GCM, Schlüsselableitung via PBKDF2 (und Spuren von scrypt), `crypto.subtle`, `getRandomValues`, IV/Salt/Nonce.
- **Onboarding:** Ein-String-Setup `qsync1:...`, Generator-Modal („String erzeugen", „In Zwischenablage kopieren").
- **Optionen:** Gerätename, „Versteckte Dateien synchronisieren", „Plugins synchronisieren", Attachment-/Binary-Handling, Auto-Sync-Intervall, Chunking.
- **Grenzen:** `isDesktopOnly: true` (kein Mobile), keine echte Konflikt-Diff-Oberfläche, kein feingranulares Datei-Regelwerk, minifiziertes Bundle ohne offenen Quellcode.

Vaultbridge übernimmt das bewährte Grundmuster und behebt genau diese Grenzen.

---

## 3. Architektur-Überblick

Klar getrennte Module mit definierten Schnittstellen; jedes ist isoliert verständlich und testbar.

```
+------------------+       Vault-Events        +------------------+
|  Obsidian Vault  |  <--------------------->  |   vault/ Bridge  |
| (Dateien, Adapter)|                           |  (Regeln, Echo-  |
+------------------+                            |   Guard, Apply)  |
                                                +---------+--------+
                                                          |
                                                 putFile / onChange
                                                          |
        +------------------+   Klartext<->Cipher  +-------v--------+
        |    crypto/       |  <-----------------  |  transform/    |
        | (KDF, AES-GCM,   |                      | (Verschlüss.-  |
        |  Pfad-HMAC)      |                      |  Schicht)      |
        +------------------+                      +-------+--------+
                                                          |
                                                   put/get/conflicts
                                                          |
                                                  +-------v--------+
                                                  |    store/      |
                                                  | (PouchDB, Doc- |
                                                  |  Modell, Chunk)|
                                                  +-------+--------+
                                                          |
                                                  live replication
                                                          |
                                                  +-------v--------+
                                                  | replication/   |
                                                  | (Status,Retry) |
                                                  +-------+--------+
                                                          |
                                                    HTTPS + Auth
                                                          |
                                                  +-------v--------+
                                                  |   CouchDB      |
                                                  | (nur Cipher-   |
                                                  |  text)         |
                                                  +----------------+

  Querschnitt:  conflicts/ (nutzt store+transform+crypto+ui)
                setup/     (Setup-String <-> Konfig)
                ui/        (Settings, Generator, Statusbar, Panel, Merge-View)
                main.ts    (Verdrahtung, Lifecycle)
```

### Modulverantwortlichkeiten

| Modul | Was es tut | Hängt ab von |
|---|---|---|
| `crypto/` | KDF (PBKDF2-HMAC-SHA256), AES-256-GCM ver-/entschlüsseln, Pfad-HMAC, Zufalls-IV/Salt. Rein, ohne Obsidian/Netzwerk. | WebCrypto |
| `setup/` | Setup-String kodieren/dekodieren/validieren; Generator-Payload. | `crypto/` (für optionale String-Verschlüsselung) |
| `store/` | PouchDB-Wrapper: lokale DB, Note-/Chunk-Dokumentmodell, `putFile/getFile/deleteFile`, Konfliktliste, Revisions-Zugriff, Bereinigung. | PouchDB |
| `transform/` | Bidirektionale Krypto-Schicht: Klartext-Datei ↔ verschlüsseltes Speicherdoc + Chunks. | `crypto/`, `store/` |
| `replication/` | Live-/manuelle Replikation starten/stoppen, Status-Events, Retry/Backoff, WLAN-Gate. | `store/` (PouchDB replicate) |
| `vault/` | Brücke Obsidian ↔ Store: Vault-Events beobachten, Remote-Änderungen anwenden, Include/Exclude-Regeln, versteckte Dateien via Adapter, Echo-Guard. | `store/`, `transform/`, Obsidian API |
| `conflicts/` | Konflikte erkennen, beide Seiten entschlüsseln, Diff-Modell erzeugen, Auflösung anwenden, verlierende Revisionen bereinigen. | `store/`, `transform/`, `crypto/` |
| `history/` | Datei-Versionsverlauf über CouchDB-Revisionen auflisten und wiederherstellen. | `store/`, `transform/` |
| `ui/` | Settings-Tab, Setup-Generator-Modal (+QR), Statusbar, Sync-Panel-View, Konflikt-Merge-View, Verlauf-View, Selbsttest. | alle obigen |
| `main.ts` | Plugin-Lebenszyklus, Verdrahtung, Kommandos. | alle |

---

## 4. Datenmodell

Jede Vault-Datei wird auf ein **Note-Doc** plus null bis n **Chunk-Docs** abgebildet.

### Note-Doc

```jsonc
{
  "_id": "n:<hex>",          // HMAC-SHA256(pfad, idKey) -> deterministisch, keine Pfad-Leaks
  "_rev": "…",               // von CouchDB/PouchDB verwaltet
  "type": "note",
  "path_enc": "<b64 IV+cipher>",  // AES-GCM(echter Pfad)
  "meta_enc": "<b64 IV+cipher>",  // AES-GCM({mtime, ctime, size, mime, isBinary})
  "chunks": ["h:aa..", "h:bb.."], // geordnete Chunk-Referenzen
  "deleted": false,
  "eden": { … }              // optional: kleine Inhalte inline (siehe unten)
}
```

### Chunk-Doc

```jsonc
{
  "_id": "h:<hash>",   // hash = SHA256(plaintext + vaultSalt), gekürzt -> Dedup nur innerhalb des Vaults
  "type": "chunk",
  "data_enc": "<b64 IV+cipher>"  // AES-GCM(chunk-plaintext, evtl. gzip-komprimiert)
}
```

- **Chunking:** Inhalt wird in Blöcke (~Standard 100 KB, konfigurierbar) geteilt; kleine Dateien = 1 Chunk oder inline („eden"). Kleine Edits an großen Dateien senden nur geänderte Chunks neu.
- **Dedup:** Gleicher Inhalt → gleicher Chunk-`_id` → nur einmal gespeichert. Der `vaultSalt` (geheim, aus dem Master abgeleitet) verhindert, dass der Server Inhalte gegen bekannte Hashes korreliert.
- **Löschungen:** `deleted: true` als Tombstone, Chunks werden per Referenzzählung / periodischem GC bereinigt.
- **`_local`-Docs** (PouchDB) halten gerätelokalen Sync-Status (letzter Seq), nicht repliziert.

### Warum HMAC statt Klartext-Pfad als `_id`

Deterministisch (gleicher Pfad → gleiche id, nötig für Konflikterkennung über Geräte), aber ohne den Pfad preiszugeben. Der echte Pfad liegt nur verschlüsselt (`path_enc`). Optionaler Schalter „Pfad-Verschleierung" (Default an); bei aus wird der Pfad als lesbarer `_id` genutzt (schnelleres Debugging, weniger Privatsphäre).

---

## 5. Verschlüsselung (Ende-zu-Ende)

### Schlüsselableitung

- **KDF:** PBKDF2-HMAC-SHA256, ≥ 210 000 Iterationen (OWASP-2023-Baseline), 256-Bit-Ausgabe. WebCrypto-nativ → funktioniert identisch auf Desktop und Mobile.
- **Salt:** pro Vault fest, im Setup-String transportiert (nicht geheim). Alle Geräte leiten denselben Master ab.
- **Abgeleitete Teilschlüssel** (via HKDF aus dem Master): `contentKey` (AES-GCM), `idKey` (Pfad-HMAC), `vaultSalt` (Chunk-Hash-Salt). Trennung verhindert Schlüssel-Wiederverwendung über Zwecke.

### Verschlüsselung

- **Algorithmus:** AES-256-GCM. Pro Verschlüsselung frischer 96-Bit-Zufalls-IV (aus `getRandomValues`), gespeichert als Präfix vor dem Ciphertext. GCM-Auth-Tag sichert Integrität/Authentizität.
- **Was verschlüsselt wird:** Datei-Inhalt (Chunks), Pfad, Metadaten. **Nicht** verschlüsselt: die Doc-`_id` (ist bereits ein HMAC), Struktur-Felder (`type`, `chunks`-Liste, `deleted`).
- **Format-Version:** ein Byte Krypto-Versions-Präfix je Feld → erlaubt spätere Algorithmenwechsel ohne Bruch.

### Passphrase-Modi (Entscheidung: beides wählbar)

Der Generator entscheidet je Setup-String:

- **Eingebettet:** Passphrase steckt im String → EIN Scan/Einfügen genügt. String ist passwort-äquivalent (deutliche Warnung + Hinweis, den String wie ein Passwort zu behandeln).
- **Getrennt:** String enthält nur Server + Zugangsdaten + Salt; Passphrase wird am Gerät separat eingegeben. Selbst ein abgefangener String gibt keinen Klartext preis.

Ein Flag im String (`pp: embedded|separate`) signalisiert dem Client, ob nach der Passphrase gefragt werden muss.

### Passphrase-Rotation (v1)

- Neue Passphrase → neuer Master + neue Teilschlüssel; **alter Schlüssel bleibt** zum Entschlüsseln vorhandener Docs erhalten.
- Ablauf: (1) neue Salt/Passphrase erzeugen, (2) alle Note-/Chunk-Docs entschlüsseln (alt) und neu verschlüsseln (neu) und schreiben, (3) ein signiertes **Key-Epoch-Marker-Doc** (`_local` + repliziert) hebt die aktive Epoche, (4) andere Geräte erkennen die neue Epoche, fragen (bei „getrennt") nach der neuen Passphrase und übernehmen.
- Jedes Krypto-Feld trägt eine **Epoch-Kennung** → Übergangsphase, in der alte und neue Docs koexistieren, ist sauber entschlüsselbar.
- Risiko/Behandlung: Rotation ist eine große Schreiboperation → als klarer, abbrechbarer, fortsetzbarer Batch mit Fortschrittsanzeige umgesetzt; Konflikte während der Rotation werden nach der Rotation über die normale Konflikt-UI aufgelöst. **Höchstes Einzelrisiko in v1** — bekommt eigene, gründliche Tests.

---

## 6. Setup-String & Generator

### Format

```
vbridge1:<base64url(payload)>
```

`payload` (JSON, base64url-kodiert; im Modus „getrennt" fehlt schlicht das `passphrase`-Feld — die Server-Zugangsdaten bleiben lesbar, damit sich der Client verbinden kann, bevor die Passphrase eingegeben wird):

```jsonc
{
  "v": 1,
  "couchUrl": "https://host:6984",
  "db": "vault_xyz",
  "user": "…",
  "pass": "…",
  "kdfSalt": "<b64>",
  "kdfIter": 210000,
  "pp": "embedded",          // oder "separate"
  "passphrase": "…",          // nur bei embedded
  "opts": { "obfuscatePaths": true, "chunkSize": 100000, "gzip": true }
}
```

### Generator (Admin)

- Eigenes Modal: Felder für Server/DB/Zugangsdaten, Passphrase (oder „Passphrase getrennt lassen"-Schalter), Optionen.
- Ausgabe: der String **plus QR-Code** (fürs Handy scannen) + „In Zwischenablage kopieren".
- Validierung vor Ausgabe: Test-Verbindung/Auth optional direkt im Generator.

### Client-Einrichtung

- String einfügen **oder** QR scannen → Felder werden befüllt → „Speichern & Verbinden".
- Bei `pp: separate`: zusätzliche Passphrase-Abfrage.
- Gerätename vorbelegt (Rechner-/Gerätename), änderbar.

---

## 7. Replikation & Sync-Engine

- **Kern:** PouchDB `replicate.to/from` bzw. `sync` gegen CouchDB, live/kontinuierlich auf Desktop.
- **Modi (v.a. Mobile):** kontinuierlich · Intervall · „bei App-Start & -Ende" · manuell · „nur im WLAN". Umschaltbar; Default Desktop = kontinuierlich, Mobile = „bei App-Start/-Ende + manuell".
- **Echo-Guard:** Beim Anwenden einer Remote-Änderung merkt sich die Bridge Pfad+Inhalts-Hash, sodass das dadurch ausgelöste Vault-Event nicht als neue lokale Änderung zurück­geschrieben wird (verhindert Endlosschleifen).
- **Backoff:** exponentiell bei Verbindungs-/Serverfehlern; Statusanzeige rot mit klarer Ursache.
- **Batchung:** Remote-Änderungen werden gebündelt in den Vault geschrieben, um UI-Churn zu vermeiden.
- **Statusanzeige:** Statusbar (grün aktuell / blau synct / rot Fehler / grau pausiert) analog qeridoo, plus detailliertes Sync-Panel.

---

## 8. Konflikt-Diff-UI (Kernfeature)

### Erkennung

CouchDB/PouchDB behalten konkurrierende Revisionen als `_conflicts`. Das `conflicts/`-Modul fragt periodisch und nach jedem Sync die Konfliktliste ab und meldet sie an die UI (Badge in Statusbar + Panel).

### Darstellung

- Eigene **Merge-View** (Obsidian `ItemView`), pro Konflikt-Datei geöffnet.
- Beide Revisionen werden **entschlüsselt** und über einen **eigenen zweispaltigen HTML-Renderer** (Zeilen-Hunks via `diff`/jsdiff — **nicht** CodeMirror, siehe Entscheidungslog #6 und die M3-Notiz unten) gegenübergestellt: links die **aktuell gültige** Version (PouchDB-Gewinner-Rev), rechts die **Konfliktversion** (verlierende Rev).
- **Wichtige Semantik (M3):** „aktuell/Gewinner" ist auf allen Replikas dieselbe Revision, aber bei Gleich-Generations-Konflikten wählt PouchDB den Gewinner über eine **zufällige** Rev-id — die linke Spalte ist also **nicht zwingend die des lokalen Geräts**. Labels sind daher inhaltsbezogen („Aktuell"/„Konflikt"), nicht gerätebezogen, damit niemand versehentlich die eigene Änderung verwirft.
- Pro Änderungsblock (Hunk): **„← übernehmen"** / **„übernehmen →"**. Zusätzlich Fußleiste: **„Ganz Aktuell"** / **„Ganz Konflikt"** / **„Zusammenführen & speichern"**.
- **Binärdateien** (Bild/PDF/…): kein Textdiff → Karten „Aktuell (gültig)" / „Konfliktversion" mit Metadaten (Größe; mtime/Bildvorschau später).

### Auflösung

1. Aus den Hunk-Entscheidungen wird der finale Inhalt zusammengesetzt.
2. Dieser wird als neue **Gewinner-Revision** geschrieben (verschlüsselt, ggf. neue Chunks).
3. Verlierende Konflikt-Revisionen werden **bereinigt** (als gelöscht markiert), damit CouchDB konvergiert.
4. Ergebnis wird in den Vault geschrieben (Echo-Guard aktiv).

### Trennung Logik/Darstellung

Die Auflöse-Logik (Eingabe: zwei Klartext-Versionen + Hunk-Entscheidungen → Ausgabe: finaler Text; plus Revisions-Bereinigung) liegt in `conflicts/diff.ts` + `conflicts/session.ts` getrennt vom HTML-Renderer → headless unit-testbar (in M3 umgesetzt und getestet).

---

## 9. Dateisteuerung (Fremddateien wie `.claude/`)

- **Problem:** Obsidian blendet Dotfiles/-ordner aus dem Datei-Index aus. Zugriff daher direkt über `vault.adapter.list/read/write`.
- **Regel-Editor:** Liste aus Include-/Exclude-Globs, ausgewertet in Reihenfolge (spezifischer gewinnt). Master-Schalter „versteckte Dateien synchronisieren".
- **Kuratierte Defaults:**
  - Inklusiv: normale Vault-Dateien, optional `.claude/**`, `.obsidian/plugins/**`, `.obsidian/snippets/**`, `.obsidian/themes/**`.
  - Exklusiv (churn-/geräteabhängig): `.obsidian/workspace*.json`, `.obsidian/graph.json`, `.trash/**`, `.git/**`, `node_modules/**`, `main.js`, `.DS_Store`.
- **Sicherheitswarnung** beim Aktivieren von Plugin-Sync (kann fremden Code über Geräte verteilen — bewusste Entscheidung des Nutzers).

---

## 10. Mobile (iOS/iPadOS + Android)

- `isDesktopOnly: false`. Ausschließlich Web-APIs + Obsidian-Vault-Adapter, **keine** Node-APIs (`fs`, `path`, `Buffer` nur via Polyfill/Web-Äquivalent).
- PouchDB nutzt den IndexedDB-Adapter; WebCrypto für Verschlüsselung.
- Akku-/Datenschonung: WLAN-Gate, Intervall-/On-Open-Close-Modi, „Sync jetzt"-Button.
- QR-Onboarding statt langem String-Tippen.
- Getestet gegen die Capacitor-Einschränkungen (kein synchrones FS, begrenzter Hintergrund-Betrieb).

---

## 11. Datei-Versionsverlauf (v1)

- Nutzt vorhandene CouchDB-Revisionen: `history/` listet frühere `_rev`-Stände eines Dokuments (soweit von CouchDB `revs_limit` vorgehalten).
- **Verlauf-View:** Zeitliste der Versionen einer Datei; Auswahl → entschlüsselte Vorschau + Diff gegen aktuell; **„diese Version wiederherstellen"** schreibt sie als neue Gewinner-Revision.
- Hinweis: CouchDB komprimiert alte Revisionen (Compaction) — der Verlauf reicht so weit zurück, wie der Server sie hält. `revs_limit`-Empfehlung in der Doku.

---

## 12. Fehlerbehandlung

| Situation | Verhalten |
|---|---|
| Verbindungs-/Serverfehler | Exponentielles Backoff, roter Status mit Ursache, „erneut versuchen". |
| Auth-Fehler (401/403) | Klarer Hinweis, Setup erneut öffnen. |
| Falsche Passphrase | Explizite Meldung „Passphrase passt nicht"; **kein** Schreiben kaputter Dateien. Entschlüsselung schlägt kontrolliert fehl (GCM-Tag ungültig). |
| Schreibkonflikt bei Auflösung | Automatischer Retry mit frischer Revision. |
| Chunk fehlt (unvollständige Replikation) | Datei bleibt im Vault unangetastet, Warnung, Re-Fetch. |
| DB voll / Quota | Warnung, Sync pausiert, Hinweis auf Compaction/Storage. |

---

## 13. Sicherheitsmodell & Bedrohungen

- **Vertrauensgrenze:** Der CouchDB-Server ist *nicht* vertrauenswürdig — er sieht nur Ciphertext, HMAC-ids und Struktur-Metadaten (Anzahl Docs/Chunks, Größenordnung). Inhalt, Pfade, Metadaten sind verschlüsselt.
- **Was der Server erfährt (Restleck):** ungefähre Dateigrößen (über Chunk-Zahl), Änderungszeitpunkte (Replikations-Timing), Gesamt-Vault-Größe. Für ein privates Vault akzeptabel; in der Doku transparent gemacht.
- **Setup-String = Geheimnis** (bei eingebetteter Passphrase passwort-äquivalent). UI warnt entsprechend.
- **Kein Nachladen von Code**, keine externen Endpunkte außer der vom Nutzer konfigurierten CouchDB → Community-konform.
- **Integrität:** GCM-Auth-Tag verhindert unbemerkte Manipulation einzelner Felder durch den Server.

---

## 14. UI/UX-Komponenten

1. **Settings-Tab:** Verbindung (String/QR einfügen, Selbsttest), Gerätename, Sync-Modus, Datei-Regeln, Verschlüsselung (Pfad-Verschleierung, Rotation starten), erweiterte Optionen (Chunk-Größe, gzip).
2. **Setup-Generator-Modal:** Admin erzeugt String + QR.
3. **Statusbar:** Farbstatus + Konflikt-Badge.
4. **Sync-Panel (View):** letzter Sync, offene Änderungen, Fehler, Geräte-Präsenz „zuletzt gesehen", „Sync jetzt"/„Pause".
5. **Konflikt-Merge-View:** siehe §8.
6. **Verlauf-View:** siehe §11.
7. **Selbsttest-Dialog:** prüft Verbindung → Auth → Verschlüsselungs-Roundtrip → meldet grün/rot je Schritt.

---

## 15. Projekt-/Repo-Struktur & Build (Community-Plugin)

```
vaultbridge/
  manifest.json          # id: vaultbridge, isDesktopOnly: false
  package.json
  tsconfig.json
  esbuild.config.mjs     # Bundle main.ts -> main.js
  versions.json
  styles.css
  LICENSE                # MIT
  README.md              # Englisch (Community), plus Server-Setup-Guide
  src/
    main.ts
    crypto/  setup/  store/  transform/  replication/
    vault/   conflicts/ history/ ui/
  test/                  # Vitest/Jest Unit- + Integrationstests
  .github/workflows/release.yml
  docs/
    superpowers/specs/…  # dieses Dokument
    server-setup.md      # Docker-Compose + Cloudant-Free-Tier-Anleitung
```

- **Build:** esbuild bündelt `main.ts` → `main.js` (kein obfuskierter Code; Quellen offen).
- **Release-Workflow:** GitHub Actions taggt Version, hängt `main.js`/`manifest.json`/`styles.css` an ein Release.
- **Ohne eigene Daten:** keine Telemetrie, kein hartkodierter Server, keine gebündelten Credentials.
- **Einreichung:** PR gegen `obsidianmd/obsidian-releases` (`community-plugins.json`).
- **Server-Anbindung erleichtern:** `docs/server-setup.md` mit (a) Docker-Compose-Ein-Zeilen-CouchDB inkl. CORS-Setup, (b) gehostetem Free-Tier (z.B. IBM Cloudant), (c) Selbsttest im Plugin.

---

## 16. Teststrategie

- **Unit:** `crypto/` (Roundtrip, falsche Passphrase → Fehler), `setup/` (Encode/Decode/Validierung), `store/` (Chunking + Reassembly, Dedup), `conflicts/` (zwei Klartext-Versionen + Hunk-Entscheidungen → erwarteter Merge), `vault/`-Regel-Matcher (Globs), `history/`.
- **Integration:** lokale PouchDB ↔ Test-CouchDB (Docker oder `pouchdb-server` in-memory): Replikation, Konfliktprovokation, Auflösung + Revisions-Bereinigung, Rotation über zwei „Geräte".
- **Manuell/Geräte:** Desktop ↔ Mobile Round-Trip, WLAN-Gate, QR-Onboarding.
- **Logik von Darstellung getrennt** halten, damit Diff-/Merge- und Rotations-Logik headless testbar sind (TDD).

---

## 17. Spätere Phasen (Phase 2+)

- Delta/Patch-Sync für sehr große Binärdateien.
- Mehrere Sync-Profile / mehrere Vaults gegen dieselbe DB.
- Erweiterte Compaction-/GC-Steuerung aus dem Plugin heraus.
- Optionale serverseitige Suche (bricht E2E — nur als bewusstes Opt-in).

---

## 18. Risiken & offene Punkte

- **Passphrase-Rotation** ist die komplexeste v1-Komponente (Massen-Reencrypt + Epochen-Koordination über Geräte). Eigene, gründliche Tests; als abbrechbarer/fortsetzbarer Batch gebaut.
- **Mobile-Einschränkungen** (Hintergrund-Sync, IndexedDB-Quota) müssen früh am echten Gerät verifiziert werden.
- ~~CodeMirror-Merge-Integration~~ — in M3 durch einen eigenen HTML-Renderer + `diff`/jsdiff ersetzt (kein Bundling-Risiko, mobil identisch, Auflöse-Logik headless testbar). Risiko damit erledigt.
- **CouchDB-CORS** ist die häufigste Onboarding-Fehlerquelle → Selbsttest muss das explizit prüfen und melden.
- **Bundle-Größe** (PouchDB) — akzeptiert zugunsten Zuverlässigkeit.

---

## 19. Entscheidungslog

| # | Entscheidung | Wahl | Begründung |
|---|---|---|---|
| 1 | Backend | **CouchDB behalten** (PouchDB bündeln) | Erprobtes Replikations-/Konfliktprotokoll, Mobile geschenkt, geringstes Risiko. Postgres/Supabase bewusst verworfen. |
| 2 | Verschlüsselung | **Ende-zu-Ende** (AES-256-GCM, PBKDF2, Pfad-HMAC) | Server sieht nie Klartext, auch keine Pfade. |
| 3 | Passphrase-Übergabe | **Beides wählbar** (eingebettet/getrennt) | Admin entscheidet Komfort vs. Sicherheit pro String. |
| 4 | v1-Umfang | **Voller Funktionsumfang** inkl. Verlauf + Rotation | Nutzerwunsch; Rotation als höchstes Risiko markiert. |
| 5 | Mobile | **iOS + Android** in v1 | `isDesktopOnly: false`, nur Web-APIs. |
| 6 | Diff-UI | **Eigener HTML-Renderer + `diff`/jsdiff** (M3-Revision; ursprünglich CodeMirror Merge geplant), Logik von Darstellung getrennt | Kein Bundling-Risiko, mobil identisch, Auflöse-Logik headless testbar. Vom Nutzer in M3 bestätigt. |
| 7 | Name/Repo | **Vaultbridge**, MIT, ohne eigene Daten | Community-konform, eigenständige Marke. |
