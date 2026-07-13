import { describe, it, expect } from "vitest";
import { testConnection } from "../src/setup/connection";

const base = { couchUrl: "https://couch.example:6984/", db: "vault_abc", user: "u", pass: "p" };

function fakeFetch(map: Record<string, { status: number; ok?: boolean }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    for (const key of Object.keys(map)) {
      if (url.includes(key)) {
        const { status } = map[key];
        return { status, ok: status >= 200 && status < 300 } as Response;
      }
    }
    throw new Error("unerwartete URL: " + url);
  }) as unknown as typeof fetch;
}

describe("testConnection", () => {
  it("meldet Server-nicht-erreichbar", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.step).toBe("url");
  });

  it("meldet Auth-Fehler bei 401", async () => {
    const r = await testConnection(base, fakeFetch({ "6984/": { status: 401 } }));
    expect(r.ok).toBe(false);
    expect(r.step).toBe("auth");
  });

  it("meldet Erfolg, wenn DB noch nicht existiert (404)", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 404 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.step).toBe("db");
    expect(r.message).toMatch(/noch nicht/);
  });

  it("meldet vollen Erfolg, wenn DB existiert", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 200 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.step).toBe("db");
  });
});
