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

  it("mergePreview markiert übernommene Zeilen mit ihrer Herkunft", () => {
    const s = new ConflictSession(input());
    // Default (lokal): Kontextzeilen a,c; geänderte Zeile b aus "local".
    // Zeilen behalten ihr abschließendes \n (nur die letzte Datei-Zeile nicht).
    expect(s.mergePreview()).toEqual([
      { text: "a\n", origin: "context" },
      { text: "b\n", origin: "local" },
      { text: "c", origin: "context" },
    ]);
    s.setDecision(0, "remote");
    expect(s.mergePreview()).toEqual([
      { text: "a\n", origin: "context" },
      { text: "B2\n", origin: "remote" },
      { text: "c", origin: "context" },
    ]);
    // Vorschau und tatsächliches Ergebnis müssen übereinstimmen.
    expect(s.mergePreview().map((l) => l.text).join("")).toBe(utf8.decode(s.resultBytes()));
  });

  it("combinedBytes fügt A + B zusammen (beide Fassungen)", () => {
    const s = new ConflictSession(input());
    // a (Kontext) + b (aus A) + B2 (aus B) + c (Kontext)
    expect(utf8.decode(s.combinedBytes())).toBe("a\nb\nB2\nc");
    // combinedPreview kennzeichnet die Herkunft und stimmt mit den Bytes überein.
    expect(s.combinedPreview().map((l) => l.origin)).toEqual(["context", "local", "remote", "context"]);
    expect(s.combinedPreview().map((l) => l.text).join("")).toBe(utf8.decode(s.combinedBytes()));
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
