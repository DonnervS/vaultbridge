import { describe, it, expect } from "vitest";
import { checkCouchUrl, isLocalHostname } from "../src/setup/couchUrl";

const levels = (raw: string) => checkCouchUrl(raw).hints.map((h) => h.level);
const text = (raw: string) => checkCouchUrl(raw).hints.map((h) => h.message).join(" | ");

describe("checkCouchUrl", () => {
  it("meldet zu einer leeren Eingabe nichts", () => {
    expect(checkCouchUrl("   ")).toEqual({ hints: [], normalized: "" });
  });

  it("meldet zur leeren Zeichenkette nichts", () => {
    expect(checkCouchUrl("")).toEqual({ hints: [], normalized: "" });
  });

  it("verlangt ein Protokoll", () => {
    expect(levels("192.168.20.30:5984")).toContain("error");
    expect(text("192.168.20.30:5984")).toContain("http://");
  });

  it("weist den Datenbanknamen in der URL ab", () => {
    expect(levels("https://couch.example.com/vault")).toContain("error");
    expect(text("https://couch.example.com/vault")).toContain("Feld darunter");
  });

  it("erkennt die Fauxton-Oberfläche", () => {
    expect(text("http://host:5984/_utils")).toContain("Fauxton");
    expect(text("http://host:5984/_utils/")).toContain("Fauxton");
  });

  it("akzeptiert die Server-Wurzel und normalisiert den Schrägstrich", () => {
    const res = checkCouchUrl("https://couch.example.com/");
    expect(res.normalized).toBe("https://couch.example.com");
    expect(res.hints.every((h) => h.level === "ok")).toBe(true);
  });

  it("entfernt umgebenden Leerraum", () => {
    expect(checkCouchUrl("  https://couch.example.com  ").normalized).toBe("https://couch.example.com");
  });

  it("erinnert bei http ohne Port an 5984", () => {
    expect(text("http://192.168.20.30")).toContain("5984");
  });

  it("warnt bei http auf einem öffentlichen Host", () => {
    expect(text("http://couch.example.com:5984")).toContain("Unverschlüsselt");
  });

  it("warnt nicht wegen fehlender Verschlüsselung bei einer lokalen Adresse", () => {
    expect(text("http://192.168.20.30:5984")).not.toContain("Unverschlüsselt");
  });

  it("weist bei lokalen Adressen auf die Verbindungsart hin", () => {
    expect(text("http://192.168.20.30:5984")).toContain("Verbindungsart");
    expect(text("http://localhost:5984")).toContain("Verbindungsart");
  });

  it("behält den Port in der normalisierten Form", () => {
    expect(checkCouchUrl("http://192.168.20.30:5984").normalized).toBe("http://192.168.20.30:5984");
  });

  it("meldet eine unbrauchbare Eingabe als Fehler", () => {
    expect(levels("https://")).toContain("error");
  });
});

describe("isLocalHostname", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "192.168.20.30", "172.16.0.1", "172.31.255.4", "qpim.local"])(
    "erkennt %s als lokal",
    (host) => expect(isLocalHostname(host)).toBe(true),
  );

  it.each(["couch.example.com", "172.32.0.1", "8.8.8.8", "11.0.0.1"])(
    "erkennt %s als nicht lokal",
    (host) => expect(isLocalHostname(host)).toBe(false),
  );
});
