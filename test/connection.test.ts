import { describe, it, expect } from "vitest";
import { testConnection } from "../src/setup/connection";

const base = { couchUrl: "https://couch.example:6984/", db: "vault_abc", user: "u", pass: "p" };

// 2xx-Antworten liefern per Default den CouchDB-Welcome-Body, den testConnection
// auf der Wurzel jetzt verlangt. Über `body` überschreibbar (z. B. Fauxton-HTML
// simulieren, das keinen Welcome enthält).
function fakeFetch(map: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    for (const key of Object.keys(map)) {
      if (url.includes(key)) {
        const { status, body } = map[key];
        const ok = status >= 200 && status < 300;
        const payload = body !== undefined ? body : ok ? { couchdb: "Welcome" } : {};
        return {
          status,
          ok,
          json: async () => {
            if (payload === "__notjson__") throw new Error("kein JSON");
            return payload;
          },
        } as unknown as Response;
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

  it("meldet url-Fehler bei 500 auf dem Root-Endpunkt", async () => {
    const r = await testConnection(base, fakeFetch({ "6984/": { status: 500 } }));
    expect(r.ok).toBe(false);
    expect(r.step).toBe("url");
  });

  it("meldet db-Fehler bei 500 auf dem DB-Endpunkt", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 500 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.step).toBe("db");
  });

  it("meldet Auth-Fehler bei 401 auf dem DB-Endpunkt, wenn die Root ohne Auth antwortet", async () => {
    const fetchFn = fakeFetch({ "vault_abc": { status: 401 }, "6984/": { status: 200 } });
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.step).toBe("auth");
  });

  it("meldet db-Fehler, wenn der zweite Request wirft", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return { status: 200, ok: true, json: async () => ({ couchdb: "Welcome" }) } as unknown as Response;
      throw new Error("Verbindung verloren");
    }) as unknown as typeof fetch;
    const r = await testConnection(base, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.step).toBe("db");
  });

  it("meldet url-Fehler, wenn die Root keine CouchDB-Welcome liefert (z. B. /_utils gibt JSON ohne Welcome)", async () => {
    const r = await testConnection(base, fakeFetch({ "6984/": { status: 200, body: { fauxton: true } } }));
    expect(r.ok).toBe(false);
    expect(r.step).toBe("url");
    expect(r.message).toMatch(/_utils|CouchDB-API/);
  });

  it("meldet url-Fehler, wenn die Root gar kein JSON liefert (Fauxton-HTML)", async () => {
    const r = await testConnection(base, fakeFetch({ "6984/": { status: 200, body: "__notjson__" } }));
    expect(r.ok).toBe(false);
    expect(r.step).toBe("url");
  });
});
