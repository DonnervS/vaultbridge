import { describe, it, expect } from "vitest";
import { splitIntoChunks, joinChunks, chunkId } from "../src/store/chunker";

const salt = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);

describe("chunker", () => {
  it("splittet und fügt wieder zusammen (exakt teilbar)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chunks = splitIntoChunks(data, 2);
    expect(chunks.length).toBe(3);
    expect([...joinChunks(chunks)]).toEqual([...data]);
  });

  it("splittet mit Rest korrekt", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = splitIntoChunks(data, 2);
    expect(chunks.length).toBe(3);
    expect([...chunks[2]]).toEqual([5]);
    expect([...joinChunks(chunks)]).toEqual([...data]);
  });

  it("leere Eingabe ergibt keinen Chunk", () => {
    expect(splitIntoChunks(new Uint8Array(0), 4).length).toBe(0);
  });

  it("chunkId ist deterministisch, inhaltsabhängig und salt-abhängig", async () => {
    const c = new Uint8Array([1, 2, 3]);
    const id1 = await chunkId(salt, c);
    const id2 = await chunkId(salt, new Uint8Array([1, 2, 3]));
    const id3 = await chunkId(salt, new Uint8Array([1, 2, 4]));
    const id4 = await chunkId(new Uint8Array(16), c);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toBe(id4);
    expect(id1.startsWith("h:")).toBe(true);
  });
});
