import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "../src/crypto/rotation";

describe("Epoch-Marker", () => {
  it("Verifikations-Token: korrekter Schlüssel akzeptiert, falscher lehnt ab", async () => {
    const k1 = await deriveKeys("p1", new Uint8Array(16).fill(1), 50000);
    const k2 = await deriveKeys("p2", new Uint8Array(16).fill(2), 50000);
    const token = await makeVerifyToken(k1, 2);
    expect(await checkVerifyToken(k1, 2, token)).toBe(true);
    expect(await checkVerifyToken(k2, 2, token)).toBe(false);
    expect(await checkVerifyToken(k1, 3, token)).toBe(false); // falsche Epoche
  });
  it("needsAdoption bei höherer Marker-Epoche", () => {
    expect(needsAdoption(1, { epoch: 2, kdfSalt: "s", kdfIter: 1, verify: "v" })).toBe(true);
    expect(needsAdoption(2, { epoch: 2, kdfSalt: "s", kdfIter: 1, verify: "v" })).toBe(false);
    expect(needsAdoption(1, null)).toBe(false);
  });
});
