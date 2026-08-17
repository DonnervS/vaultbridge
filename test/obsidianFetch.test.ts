import { describe, it, expect } from "vitest";
import { makeRequestUrlFetch, RequestUrlLike } from "../src/store/obsidianFetch";

interface Captured {
  url: string; method: string; headers: Record<string, string>;
  body?: ArrayBuffer | string; throw: boolean;
}

function fakeRequest(
  reply: { status: number; headers?: Record<string, string>; body?: string },
  captured: Captured[] = [],
): { request: RequestUrlLike; captured: Captured[] } {
  const request: RequestUrlLike = (opts) => {
    captured.push(opts as Captured);
    const text = reply.body ?? "";
    return Promise.resolve({
      status: reply.status,
      headers: reply.headers ?? { "content-type": "application/json" },
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
      text,
    });
  };
  return { request, captured };
}

describe("makeRequestUrlFetch", () => {
  it("reicht URL, Methode und Header durch", async () => {
    const { request, captured } = fakeRequest({ status: 200, body: "{}" });
    const f = makeRequestUrlFetch(request);
    await f("http://host:5984/db/doc", { method: "PUT", headers: { Authorization: "Basic x" } });
    expect(captured[0].url).toBe("http://host:5984/db/doc");
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].headers.authorization).toBe("Basic x");
  });

  it("setzt throw:false, damit Fehlerstatus als Antwort ankommen", async () => {
    const { request, captured } = fakeRequest({ status: 404, body: '{"error":"not_found"}' });
    const f = makeRequestUrlFetch(request);
    const res = await f("http://host:5984/db/fehlt");
    expect(captured[0].throw).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("liefert eine auswertbare JSON-Antwort", async () => {
    const { request } = fakeRequest({ status: 200, body: '{"couchdb":"Welcome"}' });
    const res = await makeRequestUrlFetch(request)("http://host:5984/");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ couchdb: "Welcome" });
  });

  it("macht Header case-insensitiv lesbar", async () => {
    const { request } = fakeRequest({ status: 200, headers: { etag: '"3-abc"' }, body: "{}" });
    const res = await makeRequestUrlFetch(request)("http://host:5984/db/doc");
    expect(res.headers.get("ETag")).toBe('"3-abc"');
  });

  it("erzeugt für 304 eine Antwort ohne Rumpf", async () => {
    const { request } = fakeRequest({ status: 304 });
    const res = await makeRequestUrlFetch(request)("http://host:5984/db/doc");
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("überträgt einen String-Rumpf unverändert", async () => {
    const { request, captured } = fakeRequest({ status: 201, body: "{}" });
    await makeRequestUrlFetch(request)("http://host:5984/db", {
      method: "POST", body: '{"_id":"x"}',
    });
    expect(captured[0].body).toBe('{"_id":"x"}');
  });

  it("überträgt einen Binär-Rumpf als ArrayBuffer", async () => {
    const { request, captured } = fakeRequest({ status: 201, body: "{}" });
    const payload = new Uint8Array([1, 2, 3]);
    await makeRequestUrlFetch(request)("http://host:5984/db", { method: "POST", body: payload });
    expect(new Uint8Array(captured[0].body as ArrayBuffer)).toEqual(payload);
  });

  it("akzeptiert ein Request-artiges Objekt als erstes Argument", async () => {
    const { request, captured } = fakeRequest({ status: 200, body: "{}" });
    await makeRequestUrlFetch(request)(new URL("http://host:5984/db"));
    expect(captured[0].url).toBe("http://host:5984/db");
  });
});
