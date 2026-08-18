import { describe, it, expect } from "vitest";
import { planAutoResolve, planResolutionStep, ConflictBranch } from "../src/conflicts/autoResolve";

function branch(rev: string, hash: string, changedAt: number, deleted = false): ConflictBranch {
  return { rev, hash, changedAt, deleted };
}

describe("planAutoResolve", () => {
  it("liefert null, wenn es keinen Konfliktzweig gibt", () => {
    expect(planAutoResolve(branch("2-a", "H1", 100), [])).toBeNull();
  });

  it("erkennt inhaltsgleiche Zweige und verwirft nur die Verlierer", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H1", 200)]);
    expect(plan).toEqual({ kind: "identical", keep: "2-a", prune: ["2-b"] });
  });

  it("behandelt beliebig viele inhaltsgleiche Zweige", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [
      branch("2-b", "H1", 200),
      branch("2-c", "H1", 50),
    ]);
    expect(plan).toEqual({ kind: "identical", keep: "2-a", prune: ["2-b", "2-c"] });
  });

  it("wertet gleichen Hash bei unterschiedlichem deleted-Flag NICHT als identisch", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H1", 200, true)]);
    expect(plan?.kind).toBe("newest-wins");
  });

  it("lässt bei echter Abweichung den neueren changedAt gewinnen", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "H2", 200)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-b",
      prune: ["2-a"],
      loser: branch("2-a", "H1", 100),
      contentLoser: branch("2-a", "H1", 100),
    });
  });

  it("behält den Gewinner, wenn er selbst der neuere ist", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 300), [branch("2-b", "H2", 200)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-a",
      prune: ["2-b"],
      loser: branch("2-b", "H2", 200),
      contentLoser: branch("2-b", "H2", 200),
    });
  });

  it("meldet keinen contentLoser, wenn nur eine Löschung unterliegt", () => {
    // Bearbeitung (Gewinner) gegen ältere Löschung: es steht nichts auf dem
    // Spiel, ein Sidecar wäre leer.
    const plan = planAutoResolve(branch("2-a", "H1", 300), [branch("2-b", "LEER", 200, true)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-a",
      prune: ["2-b"],
      loser: branch("2-b", "LEER", 200, true),
      contentLoser: null,
    });
  });

  it("meldet bei gewinnender Löschung die unterlegene Fassung als contentLoser", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 100), [branch("2-b", "LEER", 300, true)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-b",
      prune: ["2-a"],
      loser: branch("2-a", "H1", 100),
      contentLoser: branch("2-a", "H1", 100),
    });
  });

  it("überspringt für den contentLoser eine neuere Löschung zugunsten einer älteren Fassung mit Inhalt", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 500), [
      branch("2-b", "H2", 100), // ältere Bearbeitung
      branch("2-c", "LEER", 400, true), // neuere Löschung, aber ohne Inhalt
    ]);
    expect((plan as { loser: ConflictBranch }).loser.rev).toBe("2-c");
    expect((plan as { contentLoser: ConflictBranch | null }).contentLoser?.rev).toBe("2-b");
  });

  it("entscheidet bei gleichem changedAt über die lexikographisch größte Revision", () => {
    const plan = planAutoResolve(branch("2-aaa", "H1", 100), [branch("2-zzz", "H2", 100)]);
    expect(plan?.keep).toBe("2-zzz");
  });

  it("verwirft inhaltsgleiche Zweige mit, wenn ein dritter abweicht", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 300), [
      branch("2-b", "H1", 100), // identisch zum Gewinner
      branch("2-c", "H2", 200), // echte Abweichung, aber älter
    ]);
    expect(plan?.kind).toBe("newest-wins");
    expect(plan?.keep).toBe("2-a");
    expect(new Set(plan!.prune)).toEqual(new Set(["2-b", "2-c"]));
    expect((plan as { loser: ConflictBranch }).loser.rev).toBe("2-c");
  });

  it("wählt als Verlierer für die Sicherung den neuesten abweichenden Zweig", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 500), [
      branch("2-b", "H2", 100),
      branch("2-c", "H3", 400),
    ]);
    expect((plan as { loser: ConflictBranch }).loser.rev).toBe("2-c");
  });

  it("behandelt einen fehlenden changedAt (0) als ältesten Stand", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 0), [branch("2-b", "H2", 1)]);
    expect(plan?.keep).toBe("2-b");
  });
});

describe("planResolutionStep", () => {
  it("verwirft nur, wenn CouchDBs Gewinner ohnehin gewinnt", () => {
    expect(planResolutionStep("3-a", "3-a", false)).toBe("prune");
  });

  it("verwirft auch dann nur, wenn dieser Gewinner eine Löschung ist", () => {
    // Das gültige Dokument IST hier schon das gelöschte — nichts zu schreiben.
    expect(planResolutionStep("3-a", "3-a", true)).toBe("prune");
  });

  it("schreibt die gewinnende Fassung, wenn CouchDB einen anderen Zweig führt", () => {
    expect(planResolutionStep("2-b", "3-a", false)).toBe("write");
  });

  it("schreibt eine gewinnende Löschung ALS Löschung", () => {
    // Ohne diesen Fall käme die gelöschte Datei als leere Notiz zurück.
    expect(planResolutionStep("2-b", "3-a", true)).toBe("write-deleted");
  });
});
