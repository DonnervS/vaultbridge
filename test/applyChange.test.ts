import { describe, it, expect } from "vitest";
import { EchoGuard, contentHash, decideVaultAction } from "../src/vault/applyChange";

describe("EchoGuard", () => {
  it("erkennt eine gerade angewandte Schreibung als Echo (einmalig)", () => {
    const g = new EchoGuard();
    g.markApplied("a.md", "hash1");
    expect(g.isEcho("a.md", "hash1")).toBe(true);
    // nach dem Konsum nicht mehr als Echo gewertet
    expect(g.isEcho("a.md", "hash1")).toBe(false);
  });

  it("anderer Inhalt am selben Pfad ist kein Echo", () => {
    const g = new EchoGuard();
    g.markApplied("a.md", "hash1");
    expect(g.isEcho("a.md", "hash2")).toBe(false);
  });
});

describe("contentHash", () => {
  it("ist deterministisch und inhaltsabhängig", async () => {
    const h1 = await contentHash(new Uint8Array([1, 2, 3]));
    const h2 = await contentHash(new Uint8Array([1, 2, 3]));
    const h3 = await contentHash(new Uint8Array([1, 2, 4]));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("decideVaultAction", () => {
  it("write bei nicht gelöschtem Remote", () => {
    expect(decideVaultAction({ path: "a", deleted: false }, false)).toBe("write");
  });
  it("delete bei gelöschtem Remote, das lokal existiert", () => {
    expect(decideVaultAction({ path: "a", deleted: true }, true)).toBe("delete");
  });
  it("noop bei gelöschtem Remote, das lokal nicht existiert", () => {
    expect(decideVaultAction({ path: "a", deleted: true }, false)).toBe("noop");
  });
});
