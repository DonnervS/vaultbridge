import { describe, it, expect } from "vitest";
import { startSync } from "../src/store/replication";
import { createTestPouch } from "./helpers/pouch";

describe("startSync", () => {
  it("repliziert Dokumente einmalig (live:false) und meldet idle am Ende", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    await a.put({ _id: "d1", n: 1 });
    await b.put({ _id: "d2", n: 2 });

    const statuses: string[] = [];
    await new Promise<void>((resolve) => {
      startSync(a, b, { live: false }, (s) => {
        statuses.push(s);
        if (s === "idle") resolve();
      });
    });

    // Beide Seiten haben beide Docs.
    expect((await a.get<{ n: number }>("d2")).n).toBe(2);
    expect((await b.get<{ n: number }>("d1")).n).toBe(1);
    expect(statuses).toContain("idle");
    await a.destroy();
    await b.destroy();
  });

  it("stop() bricht Live-Sync ab, ohne zu werfen", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    const handle = startSync(a, b, { live: true }, () => {});
    handle.stop();
    await a.destroy();
    await b.destroy();
    expect(true).toBe(true);
  });
});
