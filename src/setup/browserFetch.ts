/**
 * Die EINE Stelle im Plugin, an der das globale `fetch` benannt wird.
 *
 * Warum überhaupt `fetch` und nicht Obsidians `requestUrl`: Verbindungstest und
 * Selbsttest sollen genau den HTTP-Weg ausüben, den PouchDB im Normalbetrieb
 * nimmt — einschließlich CORS-Preflight. Mit `requestUrl` liefen beide Tests
 * grün, während der echte Sync an CORS bzw. an Chromiums Local Network Access
 * scheitert; genau diesen Fall sollen sie aufdecken. Der requestUrl-Weg wird im
 * Selbsttest deshalb zusätzlich als zweiter Adapter geprüft, nie als Ersatz.
 *
 * Der eigentliche Datenverkehr läuft nicht hierüber, sondern über den in den
 * Einstellungen gewählten Transportweg (siehe `settings.transport`).
 *
 * ESLint meldet hier `no-restricted-globals` als Warnung. Sie bleibt bewusst
 * stehen: Das offizielle obsidianmd-Regelwerk verbietet ein gezieltes
 * `eslint-disable` für genau diese Regel (`eslint-comments/no-restricted-disable`),
 * ein Abschalten wäre also ein Fehler statt einer Ausnahme. Statt die Warnung zu
 * verstecken, ist sie auf diese eine, dokumentierte Stelle zusammengezogen.
 */
export const browserFetch: typeof fetch = fetch;
