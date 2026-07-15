import { describe, it, expect } from "vitest";
import { listAllFiles, ListingAdapter } from "../src/vault/adapterScan";

function fakeAdapter(tree: Record<string, { files: string[]; folders: string[] }>): ListingAdapter {
  return { list: async (p) => tree[p] ?? { files: [], folders: [] } };
}

describe("listAllFiles", () => {
  it("listet Dateien rekursiv inkl. versteckter Ordner", async () => {
    const adapter = fakeAdapter({
      "": { files: ["a.md"], folders: [".claude", "Ordner"] },
      ".claude": { files: [".claude/config.md"], folders: [] },
      "Ordner": { files: ["Ordner/b.md"], folders: [] },
    });
    const files = await listAllFiles(adapter, "");
    expect(files.sort()).toEqual(["Ordner/b.md", ".claude/config.md", "a.md"].sort());
  });

  it("leerer Baum ergibt leere Liste", async () => {
    expect(await listAllFiles(fakeAdapter({}), "")).toEqual([]);
  });
});
