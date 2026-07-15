import { describe, it, expect } from "vitest";
import { computeHunks, mergedText, wholeSide } from "../src/conflicts/diff";

const local = "a\nb\nc\nd";
const remote = "a\nB2\nc\nD2";

describe("diff-Modell", () => {
  it("erzeugt equal- und change-Hunks", () => {
    const hunks = computeHunks(local, remote);
    // erwartet: equal[a], change(b/B2), equal[c], change(d/D2)
    const changes = hunks.filter((h) => h.kind === "change");
    expect(changes.length).toBe(2);
    expect(hunks.some((h) => h.kind === "equal")).toBe(true);
  });

  it("mergedText nimmt per Entscheidung lokal/remote (Default lokal)", () => {
    const hunks = computeHunks(local, remote);
    expect(mergedText(hunks, {})).toBe(local); // alle Default lokal
    expect(mergedText(hunks, { 0: "remote", 1: "remote" })).toBe(remote);
    expect(mergedText(hunks, { 0: "remote", 1: "local" })).toBe("a\nB2\nc\nd");
  });

  it("wholeSide liefert komplett eine Seite", () => {
    const hunks = computeHunks(local, remote);
    expect(wholeSide(hunks, "local")).toBe(local);
    expect(wholeSide(hunks, "remote")).toBe(remote);
  });

  it("reine Ergänzung wird als change-Hunk erfasst", () => {
    const hunks = computeHunks("a\nc", "a\nb\nc");
    expect(mergedText(hunks, { 0: "remote" })).toBe("a\nb\nc");
    expect(mergedText(hunks, { 0: "local" })).toBe("a\nc");
  });
});
