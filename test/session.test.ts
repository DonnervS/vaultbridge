import { describe, it, expect } from "vitest";
import { ConflictSession } from "../src/conflicts/session";
import { utf8 } from "../src/crypto/encoding";

function input(over: Partial<any> = {}) {
  return {
    id: "n:1",
    path: "K.md",
    isBinary: false,
    local: { rev: "2-a", bytes: utf8.encode("a\nb\nc") },
    remote: { rev: "2-b", bytes: utf8.encode("a\nB2\nc") },
    ...over,
  };
}

describe("ConflictSession", () => {
  it("Default-Ergebnis = lokal", () => {
    const s = new ConflictSession(input());
    expect(utf8.decode(s.resultBytes())).toBe("a\nb\nc");
    expect(s.pruneRev()).toBe("2-b");
  });

  it("setDecision übernimmt einzelnen Hunk von remote", () => {
    const s = new ConflictSession(input());
    s.setDecision(0, "remote");
    expect(utf8.decode(s.resultBytes())).toBe("a\nB2\nc");
  });

  it("takeWhole remote nimmt komplette Remote-Seite", () => {
    const s = new ConflictSession(input());
    s.takeWhole("remote");
    expect(utf8.decode(s.resultBytes())).toBe("a\nB2\nc");
  });

  it("Binär: keine Hunks, Ergebnis = gewählte Seite", () => {
    const s = new ConflictSession(
      input({ isBinary: true, local: { rev: "2-a", bytes: new Uint8Array([1, 2]) }, remote: { rev: "2-b", bytes: new Uint8Array([9]) } }),
    );
    expect(s.hunks.length).toBe(0);
    expect([...s.resultBytes()]).toEqual([1, 2]); // Default lokal
    s.takeWhole("remote");
    expect([...s.resultBytes()]).toEqual([9]);
  });
});
