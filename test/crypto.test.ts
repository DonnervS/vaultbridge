import { describe, it, expect } from "vitest";
import { deriveKeys, encryptBytes, decryptBytes, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";

const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe("crypto", () => {
  it("verschlüsselt und entschlüsselt einen Roundtrip", async () => {
    const keys = await deriveKeys("richtig-geheim", salt, 50000);
    const plaintext = utf8.encode("Vertraulicher Vault-Inhalt äöü");
    const blob = await encryptBytes(keys.contentKey, plaintext);
    expect(blob[0]).toBe(1); // Versions-Präfix
    expect(blob.length).toBeGreaterThan(1 + 12 + plaintext.length); // + GCM-Tag
    const back = await decryptBytes(keys.contentKey, blob);
    expect(utf8.decode(back)).toBe("Vertraulicher Vault-Inhalt äöü");
  });

  it("nutzt pro Verschlüsselung einen frischen IV (unterschiedliche Ciphertexte)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const p = utf8.encode("gleich");
    const a = await encryptBytes(keys.contentKey, p);
    const b = await encryptBytes(keys.contentKey, p);
    expect([...a]).not.toEqual([...b]);
  });

  it("scheitert kontrolliert bei falscher Passphrase (GCM-Tag)", async () => {
    const good = await deriveKeys("richtig", salt, 50000);
    const bad = await deriveKeys("falsch", salt, 50000);
    const blob = await encryptBytes(good.contentKey, utf8.encode("geheim"));
    await expect(decryptBytes(bad.contentKey, blob)).rejects.toBeTruthy();
  });

  it("erzeugt deterministische, aber pfadabhängige ids", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const id1 = await pathId(keys.idKey, "Ordner/Notiz.md");
    const id2 = await pathId(keys.idKey, "Ordner/Notiz.md");
    const id3 = await pathId(keys.idKey, "Ordner/Andere.md");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith("n:")).toBe(true);
  });
});
