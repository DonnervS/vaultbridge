import { describe, it, expect } from "vitest";
import { planAutoResolve, ConflictBranch } from "../src/conflicts/autoResolve";

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
    });
  });

  it("behält den Gewinner, wenn er selbst der neuere ist", () => {
    const plan = planAutoResolve(branch("2-a", "H1", 300), [branch("2-b", "H2", 200)]);
    expect(plan).toEqual({
      kind: "newest-wins",
      keep: "2-a",
      prune: ["2-b"],
      loser: branch("2-b", "H2", 200),
    });
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
