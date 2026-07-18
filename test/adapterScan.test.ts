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

  it("überspringt Ordner, die shouldEnter ablehnt (kein Abstieg)", async () => {
    let listedNodeModules = false;
    const adapter: ListingAdapter = {
      list: async (p) => {
        if (p === "Dev/node_modules") listedNodeModules = true;
        const tree: Record<string, { files: string[]; folders: string[] }> = {
          "": { files: [], folders: ["Dev"] },
          "Dev": { files: ["Dev/main.ts"], folders: ["Dev/node_modules"] },
          "Dev/node_modules": { files: ["Dev/node_modules/x.js"], folders: [] },
        };
        return tree[p] ?? { files: [], folders: [] };
      },
    };
    const files = await listAllFiles(adapter, "", (folder) => folder !== "Dev/node_modules");
    expect(files).toEqual(["Dev/main.ts"]);
    expect(listedNodeModules).toBe(false); // Ordner wurde gar nicht erst betreten
  });
});
