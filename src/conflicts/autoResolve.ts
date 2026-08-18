/** Ein Konfliktzweig, reduziert auf das, was für die Entscheidung zählt. */
export interface ConflictBranch {
  /** CouchDB-Revision dieses Zweigs. */
  rev: string;
  /** SHA-256 der ENTSCHLÜSSELTEN Dateibytes — nicht des Dokuments. */
  hash: string;
  /** FileMeta.changedAt, 0 wenn unbekannt (Dokumente aus 1.2.x). */
  changedAt: number;
  deleted: boolean;
}

export type AutoResolvePlan =
  | { kind: "identical"; keep: string; prune: string[] }
  | {
      kind: "newest-wins";
      keep: string;
      prune: string[];
      /** Neuester abweichender Verlierer — die Zuordnung für die Meldung. */
      loser: ConflictBranch;
      /**
       * Neuester abweichender Verlierer MIT Inhalt — nur eine solche Fassung
       * ist es wert, als Sidecar gesichert zu werden. `null`, wenn
       * ausschließlich Löschungen unterlegen sind: eine Löschung trägt keinen
       * Inhalt, eine leere Sicherungsdatei wäre bloß Müll und die Meldung
       * darüber unwahr.
       */
      contentLoser: ConflictBranch | null;
    }
  | null;

function sameContent(a: ConflictBranch, b: ConflictBranch): boolean {
  return a.hash === b.hash && a.deleted === b.deleted;
}

/**
 * Neuer gewinnt; bei gleichem Zeitstempel die lexikographisch größte Revision.
 * Der Tiebreaker ist bewusst derselbe, den CouchDB selbst zur Gewinnerwahl
 * benutzt — dadurch kommen alle Geräte unabhängig voneinander zum gleichen
 * Ergebnis und es entsteht kein Ping-Pong.
 */
function newer(a: ConflictBranch, b: ConflictBranch): ConflictBranch {
  if (a.changedAt !== b.changedAt) return a.changedAt > b.changedAt ? a : b;
  return a.rev > b.rev ? a : b;
}

/**
 * Plant die automatische Auflösung eines Konflikts.
 *
 * - Sind ALLE Zweige inhaltsgleich, ist der Konflikt bedeutungslos: die
 *   Verlierer-Revisionen werden verworfen, GESCHRIEBEN WIRD NICHTS. Das ist
 *   der wesentliche Unterschied zur alten Sammel-Auflösung, die eine neue
 *   Revision schrieb und damit bei zwei gleichzeitig auflösenden Geräten
 *   sofort den nächsten Konflikt erzeugte.
 * - Sonst gewinnt der neueste Zweig; inhaltsgleiche Zweige werden mit
 *   verworfen, der neueste ABWEICHENDE Zweig wird als `loser` gemeldet (für
 *   die Zuordnung in der Meldung) und der neueste abweichende Zweig MIT
 *   INHALT als `contentLoser`, damit der Aufrufer genau den als Sidecar
 *   sichert — und keine leere Datei, wenn nur eine Löschung unterlegen ist.
 *
 * @param winner Der von CouchDB gewählte Gewinner (das gültige Dokument).
 * @param others Die Zweige aus `_conflicts`.
 */
export function planAutoResolve(winner: ConflictBranch, others: ConflictBranch[]): AutoResolvePlan {
  if (others.length === 0) return null;

  if (others.every((o) => sameContent(winner, o))) {
    return { kind: "identical", keep: winner.rev, prune: others.map((o) => o.rev) };
  }

  const all = [winner, ...others];
  const keep = all.reduce(newer);
  const losers = all.filter((b) => b.rev !== keep.rev);
  // Für die Meldung zählt nur, was inhaltlich wirklich verloren geht.
  // Mindestens ein solcher Zweig existiert hier garantiert, sonst hätte der
  // "identical"-Zweig oben schon gegriffen.
  const differing = losers.filter((b) => !sameContent(keep, b));
  const loser = differing.reduce(newer);
  // Gesichert wird nur ein Zweig MIT Inhalt. Gewinnt eine Löschung, gibt es
  // hier immer einen: zwei Löschungen sind untereinander inhaltsgleich (beide
  // ohne Inhalt) und wären oben schon aussortiert worden.
  const withContent = differing.filter((b) => !b.deleted);
  const contentLoser = withContent.length > 0 ? withContent.reduce(newer) : null;

  return {
    kind: "newest-wins",
    keep: keep.rev,
    prune: losers.map((b) => b.rev),
    loser,
    contentLoser,
  };
}

/**
 * Wie ein Plan im Store auszuführen ist:
 * - `prune`         — nur die unterlegenen Revisionen verwerfen, nichts schreiben
 * - `write`         — die gewinnende Fassung als neue Revision schreiben
 * - `write-deleted` — dasselbe, aber als LÖSCHUNG (deleted, keine Chunks)
 */
export type ResolutionStep = "prune" | "write" | "write-deleted";

/**
 * Übersetzt einen Plan in den Schritt, den der Store ausführen muss.
 *
 * Bewusst eine eigene, reine Funktion: der Ausführungsteil lebt in main.ts und
 * ist wegen des obsidian-Imports nicht testbar — genau hier steckte der Fehler,
 * dass eine gewinnende Löschung als leere Datei zurückkam.
 *
 * @param keepRev        Revision, die gewinnen soll (plan.keep).
 * @param couchWinnerRev Revision, die CouchDB derzeit für gültig hält.
 * @param keepDeleted    Ist der Gewinner eine Löschung?
 */
export function planResolutionStep(
  keepRev: string,
  couchWinnerRev: string,
  keepDeleted: boolean,
): ResolutionStep {
  // Der gültige Zweig bleibt gültig — Verwerfen genügt, kein Schreiben. Das
  // gilt für eine gewinnende Löschung genauso: das gültige Dokument IST dann
  // schon das gelöschte.
  if (keepRev === couchWinnerRev) return "prune";
  // Sonst muss die gewinnende Fassung als neue Revision geschrieben werden —
  // und zwar als Löschung, wenn sie eine ist. Ein normales Schreiben erzeugte
  // hier eine inhaltslose, aber NICHT gelöschte Notiz: die gelöschte Datei käme
  // auf allen Geräten als leere Datei zurück. Ob dieser Zweig überhaupt
  // erreicht wird, hängt allein an CouchDBs Gewinnerwahl — dieselbe
  // Nutzeraktion darf davon nicht abhängen.
  return keepDeleted ? "write-deleted" : "write";
}
