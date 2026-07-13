import { describe, it, expect } from "vitest";
import { bytesToBase64url, base64urlToBytes, bytesToHex, utf8 } from "../src/crypto/encoding";

describe("encoding", () => {
  it("base64url roundtrip (auch mit +// erzeugenden Bytes)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255, 62, 63]);
    const s = bytesToBase64url(bytes);
    expect(s).not.toMatch(/[+/=]/); // url-safe, kein Padding
    expect([...base64urlToBytes(s)]).toEqual([...bytes]);
  });

  it("utf8 roundtrip mit Umlauten", () => {
    const text = "Grüße äöü – Vault";
    expect(utf8.decode(utf8.encode(text))).toBe(text);
  });

  it("hex-Kodierung mit führenden Nullen", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});
