import { describe, it, expect } from "vitest";
import { runSelfTest } from "../src/setup/selfTest";
import { SetupPayload } from "../src/setup/setupString";
import { bytesToBase64url } from "../src/crypto/encoding";

function payload(): SetupPayload {
  return {
    v: 1,
    couchUrl: "https://couch.example:6984",
    db: "vault_abc",
    user: "u",
    pass: "p",
    kdfSalt: bytesToBase64url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    kdfIter: 50000,
    pp: "embedded",
    passphrase: "pw",
    opts: { obfuscatePaths: true, chunkSize: 100000, gzip: true },
  };
}

const okFetch = (async (input: any) => {
  const url = String(input);
  const status = url.includes("vault_abc") ? 200 : 200;
  // Root-Check verlangt jetzt den CouchDB-Welcome-Body.
  return { status, ok: true, json: async () => ({ couchdb: "Welcome" }) } as unknown as Response;
}) as unknown as typeof fetch;

describe("runSelfTest", () => {
  it("meldet Krypto-Roundtrip und Verbindung erfolgreich", async () => {
    const r = await runSelfTest(payload(), "pw", okFetch);
    expect(r.crypto.ok).toBe(true);
    expect(r.connection.ok).toBe(true);
  });

  it("Krypto-Teil ist unabhängig von der Verbindung erfolgreich", async () => {
    const failFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r = await runSelfTest(payload(), "pw", failFetch);
    expect(r.crypto.ok).toBe(true);
    expect(r.connection.ok).toBe(false);
  });
});
