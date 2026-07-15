import { describe, it, expect } from "vitest";
import { planHiddenSync } from "../src/vault/hiddenSync";

const M = (o: Record<string, string>) => new Map(Object.entries(o));

describe("planHiddenSync", () => {
  it("lädt neue lokale Datei hoch", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({}), M({}));
    expect(p.uploads).toEqual(["a"]);
    expect(p.deleteRemotes).toEqual([]);
  });
  it("lokal geändert (Hash != known) -> hochladen", () => {
    const p = planHiddenSync(M({ "a": "h2" }), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.uploads).toEqual(["a"]);
  });
  it("lokal unverändert, Remote geändert -> Download übernimmt (kein Upload)", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({ "a": "h1" }), M({ "a": "h2" }));
    expect(p.uploads).toEqual([]);
  });
  it("lokal == store -> noop", () => {
    const p = planHiddenSync(M({ "a": "h1" }), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.uploads).toEqual([]);
    expect(p.deleteRemotes).toEqual([]);
  });
  it("lokal gelöscht + war bekannt -> Remote löschen", () => {
    const p = planHiddenSync(M({}), M({ "a": "h1" }), M({ "a": "h1" }));
    expect(p.deleteRemotes).toEqual(["a"]);
  });
  it("lokal fehlt, nie bekannt -> nichts tun", () => {
    const p = planHiddenSync(M({}), M({}), M({ "a": "h1" }));
    expect(p.uploads).toEqual([]);
    expect(p.deleteRemotes).toEqual([]);
  });
});
