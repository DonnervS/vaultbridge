import { describe, it, expect } from "vitest";
import { encodeSetup, decodeSetup, SetupPayload } from "../src/setup/setupString";
import { bytesToBase64url, utf8 } from "../src/crypto/encoding";

function samplePayload(overrides: Partial<SetupPayload> = {}): SetupPayload {
  return {
    v: 1,
    couchUrl: "https://couch.example:6984",
    db: "vault_abc",
    user: "sync",
    pass: "s3cret",
    kdfSalt: "AAECAwQFBgcICQoLDA0ODw",
    kdfIter: 210000,
    pp: "embedded",
    passphrase: "meine-passphrase",
    opts: { obfuscatePaths: true, chunkSize: 100000, gzip: true },
    ...overrides,
  };
}

describe("setupString", () => {
  it("encode/decode roundtrip", () => {
    const p = samplePayload();
    const str = encodeSetup(p);
    expect(str.startsWith("vbridge1:")).toBe(true);
    expect(decodeSetup(str)).toEqual(p);
  });

  it("toleriert umgebende Leerzeichen/Zeilenumbrüche", () => {
    const str = "  " + encodeSetup(samplePayload()) + "\n";
    expect(decodeSetup(str).db).toBe("vault_abc");
  });

  it("wirft bei falschem Präfix", () => {
    expect(() => decodeSetup("qsync1:abc")).toThrow(/Präfix/);
  });

  it("wirft bei beschädigter Nutzlast", () => {
    expect(() => decodeSetup("vbridge1:@@@nicht-base64@@@")).toThrow(/beschädigt|unvollständig/);
  });

  it("wirft bei fehlendem Pflichtfeld", () => {
    const p: any = samplePayload();
    delete p.couchUrl;
    const str = "vbridge1:" + btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => decodeSetup(str)).toThrow(/couchUrl/);
  });

  it("wirft bei eingebettetem Modus ohne Passphrase", () => {
    const p = samplePayload({ pp: "embedded", passphrase: undefined });
    const str = encodeSetup(p);
    expect(() => decodeSetup(str)).toThrow(/Passphrase/);
  });

  it("akzeptiert getrennten Modus ohne Passphrase", () => {
    const p = samplePayload({ pp: "separate", passphrase: undefined });
    expect(decodeSetup(encodeSetup(p)).pp).toBe("separate");
  });

  it("wirft deutsche Meldung bei JSON-null als Nutzlast", () => {
    const str = "vbridge1:" + bytesToBase64url(utf8.encode("null"));
    expect(() => decodeSetup(str)).toThrow(/kein gültiges Objekt/);
  });

  it("wirft bei unbekanntem Passphrase-Modus", () => {
    const p: any = samplePayload({ pp: "separate" });
    p.pp = "foo";
    const str = "vbridge1:" + bytesToBase64url(utf8.encode(JSON.stringify(p)));
    expect(() => decodeSetup(str)).toThrow(/Passphrase-Modus/);
  });

  it("wirft bei nicht unterstützter Version", () => {
    const p: any = samplePayload();
    p.v = 2;
    const str = "vbridge1:" + bytesToBase64url(utf8.encode(JSON.stringify(p)));
    expect(() => decodeSetup(str)).toThrow(/Version/);
  });
});
