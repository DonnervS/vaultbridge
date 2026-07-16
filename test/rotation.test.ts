import { describe, it, expect } from "vitest";
import { deriveKeys } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore } from "../src/store/store";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const meta: FileMeta = { mtime: 1, ctime: 1, size: 2, mime: "text/markdown", isBinary: false };

describe("rotate", () => {
  it("verschlüsselt aktuelle Dateien mit dem neuen Schlüssel neu (mit neuem Schlüssel lesbar)", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    await store.putFile("b.md", utf8.encode("Beta"), meta);

    let seen = 0;
    await store.rotate(kNew, (d) => { seen = d; });
    expect(seen).toBe(2);

    // Store nach Rotation nutzt kNew -> Dateien lesbar
    expect(utf8.decode((await store.getFile("a.md"))!.bytes)).toBe("Alpha");
    expect(utf8.decode((await store.getFile("b.md"))!.bytes)).toBe("Beta");
  });

  it("ist idempotent/fortsetzbar (erneutes rotate ändert nichts mehr)", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    await store.rotate(kNew);
    let seen2 = -1;
    await store.rotate(kNew, (d, t) => { seen2 = t; });
    // alle bereits kNew-lesbar -> nichts neu zu rotieren, getFile bleibt korrekt
    expect(utf8.decode((await store.getFile("a.md"))!.bytes)).toBe("Alpha");
  });

  it("bricht bei signal.aborted ab", async () => {
    const kOld = await deriveKeys("alt", new Uint8Array(16).fill(1), 50000);
    const kNew = await deriveKeys("neu", new Uint8Array(16).fill(2), 50000);
    const store = new VaultStore(createTestPouch(), kOld, 4);
    await store.putFile("a.md", utf8.encode("Alpha"), meta);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(store.rotate(kNew, undefined, ctrl.signal)).rejects.toThrow(/abgebrochen/);
  });
});
