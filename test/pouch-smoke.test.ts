import { describe, it, expect, afterEach } from "vitest";
import { createTestPouch } from "./helpers/pouch";

describe("pouchdb memory adapter", () => {
  it("legt ein Dokument an und liest es zurück", async () => {
    const db = createTestPouch();
    await db.put({ _id: "x", value: 42 });
    const doc = await db.get<{ value: number }>("x");
    expect(doc.value).toBe(42);
    await db.destroy();
  });

  it("repliziert zwischen zwei In-Memory-DBs", async () => {
    const a = createTestPouch();
    const b = createTestPouch();
    await a.put({ _id: "doc1", n: 1 });
    await a.replicate.to(b);
    const got = await b.get<{ n: number }>("doc1");
    expect(got.n).toBe(1);
    await a.destroy();
    await b.destroy();
  });
});
