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
  | { kind: "newest-wins"; keep: string; prune: string[]; loser: ConflictBranch }
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
 *   verworfen, der neueste ABWEICHENDE Zweig wird als `loser` gemeldet, damit
 *   der Aufrufer ihn als Sidecar sichern kann.
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
  // Für die Sicherung zählt nur, was inhaltlich wirklich verloren geht.
  // Mindestens ein solcher Zweig existiert hier garantiert, sonst hätte der
  // "identical"-Zweig oben schon gegriffen.
  const loser = losers.filter((b) => !sameContent(keep, b)).reduce(newer);

  return { kind: "newest-wins", keep: keep.rev, prune: losers.map((b) => b.rev), loser };
}
