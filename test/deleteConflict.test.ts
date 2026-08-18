import { describe, it, expect } from "vitest";
import { deriveKeys, pathId } from "../src/crypto/crypto";
import { utf8 } from "../src/crypto/encoding";
import { VaultStore, ConflictVersion } from "../src/store/store";
import { contentHash } from "../src/vault/applyChange";
import { planAutoResolve, planResolutionStep, ConflictBranch } from "../src/conflicts/autoResolve";
import { createTestPouch } from "./helpers/pouch";
import type { FileMeta } from "../src/store/model";

const salt = new Uint8Array(16).fill(17);

/** Metadaten einer Inhaltsänderung mit steuerbarem Zeitstempel. */
function meta(changedAt: number, device = "Laptop"): FileMeta {
  return { mtime: 1, ctime: 1, size: 5, mime: "text/markdown", isBinary: false, device, changedAt };
}

/** Weit in der Zukunft — schlägt jeden Date.now() aus deleteFile(). */
const NACH_DER_LOESCHUNG = Date.now() + 10 * 60 * 1000;
/** Weit in der Vergangenheit — verliert gegen jeden Date.now() aus deleteFile(). */
const VOR_DER_LOESCHUNG = 1_000;

/**
 * Baut einen echten Lösch-gegen-Bearbeitung-Konflikt in dbA.
 *
 * `couchWinner` steuert, welchen Zweig CouchDB für gültig hält: die höhere
 * Revisionsgeneration gewinnt. Genau daran hing der Fehler — dieselbe
 * Nutzeraktion lief je nach CouchDBs Wahl in einen anderen Store-Aufruf.
 *
 * @param editChangedAt Zeitstempel der Bearbeitung. Größer als der Löschzeit-
 *   punkt (NACH_DER_LOESCHUNG) -> die Bearbeitung gewinnt die Planung, kleiner
 *   (VOR_DER_LOESCHUNG) -> die Löschung gewinnt.
 */
async function makeDeleteConflict(couchWinner: "loeschung" | "bearbeitung", editChangedAt: number) {
  const keys = await deriveKeys("pw", salt, 50000);
  const dbA = createTestPouch();
  const dbB = createTestPouch();
  const a = new VaultStore(dbA, keys, 1024);
  const b = new VaultStore(dbB, keys, 1024);

  await a.putFile("K.md", utf8.encode("basis"), meta(VOR_DER_LOESCHUNG));
  await dbA.replicate.to(dbB);

  if (couchWinner === "bearbeitung") {
    // Bearbeitung auf Generation 3 heben, Löschung bleibt auf 2.
    await a.putFile("K.md", utf8.encode("zwischenstand"), meta(VOR_DER_LOESCHUNG));
    await a.putFile("K.md", utf8.encode("aus A"), meta(editChangedAt));
    await b.deleteFile("K.md", "Handy");
  } else {
    // Löschung auf Generation 3 heben, Bearbeitung bleibt auf 2.
    await b.putFile("K.md", utf8.encode("zwischenstand"), meta(VOR_DER_LOESCHUNG));
    await b.deleteFile("K.md", "Handy");
    await a.putFile("K.md", utf8.encode("aus A"), meta(editChangedAt));
  }
  await dbB.replicate.to(dbA); // dbA hat jetzt den Konflikt

  const [id] = await a.listConflicts();
  const c = await a.getConflict(id);
  expect(c).not.toBeNull();
  return { keys, a, dbA, dbB, id, c: c! };
}

/** Wie in main.ts: ConflictVersion -> ConflictBranch für den Planer. */
async function toBranch(v: ConflictVersion): Promise<ConflictBranch> {
  return {
    rev: v.rev,
    hash: await contentHash(v.bytes),
    changedAt: v.meta.changedAt ?? v.meta.mtime ?? 0,
    deleted: v.deleted,
  };
}

/** Planer + Ausführungsschritt genau so verdrahtet wie in main.ts. */
async function planFor(c: { local: ConflictVersion; remotes: ConflictVersion[] }) {
  const winner = await toBranch(c.local);
  const others: ConflictBranch[] = [];
  for (const r of c.remotes) others.push(await toBranch(r));
  const plan = planAutoResolve(winner, others);
  const alle = [c.local, ...c.remotes];
  const keep = plan ? alle.find((v) => v.rev === plan.keep)! : null;
  const step = plan && keep ? planResolutionStep(plan.keep, c.local.rev, keep.deleted) : null;
  return { plan, keep, step };
}

/**
 * Eine Runde automatischer Auflösung, genau wie
 * VaultbridgePlugin.autoResolveConflicts(): Konflikt lesen, Planer fragen,
 * Ausführungsschritt bestimmen, passenden Store-Aufruf absetzen.
 */
async function resolveRound(a: VaultStore, id: string): Promise<string> {
  const c = await a.getConflict(id);
  if (!c) return "nichts";
  const { plan, keep, step } = await planFor(c);
  if (!plan || !keep || !step) return "nichts";
  switch (step) {
    case "prune":
      await a.pruneConflictRevs(c.id, plan.prune);
      break;
    case "write-deleted":
      await a.resolveConflictAsDeleted(c.id, c.path, keep.meta, plan.prune);
      break;
    default:
      await a.resolveConflict(c.id, c.path, keep.bytes, keep.meta, plan.prune);
      break;
  }
  return step;
}

/**
 * Löst, bis keine Konflikte mehr offen sind, und liefert die Schritte je Runde.
 *
 * Zwei Runden sind der Normalfall, wenn CouchDBs Gewinner NICHT der geplante
 * ist: die erste schreibt die gewinnende Fassung als neue Revision auf den
 * Zweig des CouchDB-Gewinners, danach ist der verbliebene Zweig inhaltsgleich
 * und wird in der zweiten Runde verworfen (ohne weiteres Schreiben).
 */
async function resolveAll(a: VaultStore, id: string, maxRunden = 4): Promise<string[]> {
  const schritte: string[] = [];
  for (let i = 0; i < maxRunden; i++) {
    if ((await a.listConflicts()).length === 0) break;
    schritte.push(await resolveRound(a, id));
  }
  return schritte;
}

describe("Löschung gegen Bearbeitung (echter Konflikt)", () => {
  it("Löschung gewinnt, CouchDB hält die Bearbeitung für gültig -> Datei bleibt gelöscht", async () => {
    const { a, dbA, dbB, id, c } = await makeDeleteConflict("bearbeitung", VOR_DER_LOESCHUNG);
    const { plan, keep, step } = await planFor(c);

    expect(keep!.deleted).toBe(true);
    // Der gelöschte Zweig ist NICHT der Gewinner von CouchDB -> es muss
    // geschrieben werden, und zwar als Löschung.
    expect(step).toBe("write-deleted");
    if (plan!.kind === "newest-wins") {
      // Die unterlegene Bearbeitung trägt Inhalt und gehört gesichert.
      expect(plan!.contentLoser?.deleted).toBe(false);
    }

    // Erste Runde schreibt die Löschung, zweite verwirft den nun
    // inhaltsgleichen Rest.
    expect(await resolveAll(a, id)).toEqual(["write-deleted", "prune"]);

    expect(await a.listConflicts()).toEqual([]);
    expect(await a.getFile("K.md")).toBeNull(); // NICHT als leere Datei zurück
    const nachher = await a.readNote(id);
    expect(nachher!.deleted).toBe(true);
    expect(nachher!.bytes.length).toBe(0);
    // Die Zuordnung der Löschung bleibt erhalten.
    expect(nachher!.meta.device).toBe("Handy");

    await dbA.destroy();
    await dbB.destroy();
  });

  it("Löschung gewinnt, CouchDB hält sie schon für gültig -> nur verwerfen, kein Neuschreiben", async () => {
    const { a, dbA, dbB, id, c } = await makeDeleteConflict("loeschung", VOR_DER_LOESCHUNG);
    const { plan, keep, step } = await planFor(c);

    expect(keep!.deleted).toBe(true);
    expect(step).toBe("prune");
    const revVorher = c.local.rev;

    expect(await resolveAll(a, id)).toEqual(["prune"]);

    expect(await a.listConflicts()).toEqual([]);
    expect(await a.getFile("K.md")).toBeNull();
    const nachher = await a.readNote(id);
    expect(nachher!.deleted).toBe(true);
    // Kein Neuschreiben: die Revision des Gewinners ist unverändert.
    const doc = await dbA.get(id);
    expect((doc as { _rev: string })._rev).toBe(revVorher);

    await dbA.destroy();
    await dbB.destroy();
  });

  it("Bearbeitung gewinnt, CouchDB hält die Löschung für gültig -> Datei lebt mit dem Inhalt weiter", async () => {
    const { a, dbA, dbB, id, c } = await makeDeleteConflict("loeschung", NACH_DER_LOESCHUNG);
    const { plan, keep, step } = await planFor(c);

    expect(keep!.deleted).toBe(false);
    expect(step).toBe("write");
    if (plan!.kind === "newest-wins") {
      // Verloren geht nur eine Löschung — es gibt nichts zu sichern.
      expect(plan!.loser.deleted).toBe(true);
      expect(plan!.contentLoser).toBeNull();
    }

    expect(await resolveAll(a, id)).toEqual(["write", "prune"]);

    expect(await a.listConflicts()).toEqual([]);
    const datei = await a.getFile("K.md");
    expect(utf8.decode(datei!.bytes)).toBe("aus A");
    expect((await a.readNote(id))!.deleted).toBe(false);

    await dbA.destroy();
    await dbB.destroy();
  });

  it("Bearbeitung gewinnt, CouchDB hält sie schon für gültig -> nur verwerfen", async () => {
    const { a, dbA, dbB, id, c } = await makeDeleteConflict("bearbeitung", NACH_DER_LOESCHUNG);
    const { plan, keep, step } = await planFor(c);

    expect(keep!.deleted).toBe(false);
    expect(step).toBe("prune");
    if (plan!.kind === "newest-wins") expect(plan!.contentLoser).toBeNull();

    expect(await resolveAll(a, id)).toEqual(["prune"]);

    expect(await a.listConflicts()).toEqual([]);
    expect(utf8.decode((await a.getFile("K.md"))!.bytes)).toBe("aus A");

    await dbA.destroy();
    await dbB.destroy();
  });

  it("getConflict meldet den gelöschten Zweig samt löschendem Gerät", async () => {
    const { dbA, dbB, c } = await makeDeleteConflict("bearbeitung", VOR_DER_LOESCHUNG);
    expect(c.local.deleted).toBe(false);
    expect(c.local.meta.device).toBe("Laptop");
    expect(c.remotes[0].deleted).toBe(true);
    expect(c.remotes[0].meta.device).toBe("Handy");

    await dbA.destroy();
    await dbB.destroy();
  });

  it("resolveConflict allein holte die Löschung als leere, NICHT gelöschte Datei zurück", async () => {
    // Festhalten, warum resolveConflictAsDeleted existiert: encodeFile setzt
    // `deleted` nie. Ohne den eigenen Weg käme die gelöschte Datei auf jedem
    // Gerät als 0-Byte-Notiz wieder.
    const { a, dbA, dbB, id, c } = await makeDeleteConflict("bearbeitung", VOR_DER_LOESCHUNG);
    const { plan, keep } = await planFor(c);

    await a.resolveConflict(id, c.path, keep!.bytes, keep!.meta, plan!.prune);

    const zombie = await a.getFile("K.md");
    expect(zombie).not.toBeNull();
    expect(zombie!.bytes.length).toBe(0);
    expect((await a.readNote(id))!.deleted).toBe(false);

    await dbA.destroy();
    await dbB.destroy();
  });
});

describe("deleteFile schreibt eigene Metadaten", () => {
  it("übernimmt Zeitpunkt und Gerät der Löschung, nicht die des letzten Inhalts-Schreibens", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const db = createTestPouch();
    const store = new VaultStore(db, keys, 1024);
    await store.putFile("weg.md", utf8.encode("x"), meta(VOR_DER_LOESCHUNG, "Laptop"));

    const vorher = Date.now();
    await store.deleteFile("weg.md", "Handy");
    const nachher = Date.now();

    const note = await store.readNote(await pathId(keys.idKey, "weg.md"));
    expect(note!.deleted).toBe(true);
    expect(note!.meta.device).toBe("Handy");
    expect(note!.meta.changedAt).toBeGreaterThanOrEqual(vorher);
    expect(note!.meta.changedAt).toBeLessThanOrEqual(nachher);
    expect(note!.meta.changedAt).toBeGreaterThan(VOR_DER_LOESCHUNG);

    await db.destroy();
  });

  it("ergänzt die Felder auch bei Dokumenten aus 1.2.x (ohne device/changedAt)", async () => {
    const keys = await deriveKeys("pw", salt, 50000);
    const db = createTestPouch();
    const store = new VaultStore(db, keys, 1024);
    const alt: FileMeta = { mtime: 42, ctime: 7, size: 1, mime: "text/markdown", isBinary: false };
    await store.putFile("alt.md", utf8.encode("x"), alt);

    await store.deleteFile("alt.md", "Handy");

    const note = await store.readNote(await pathId(keys.idKey, "alt.md"));
    expect(note!.meta.device).toBe("Handy");
    expect(note!.meta.changedAt).toBeGreaterThan(0);
    // Die übrigen Metadaten bleiben unangetastet.
    expect(note!.meta.mtime).toBe(42);
    expect(note!.meta.ctime).toBe(7);

    await db.destroy();
  });
});
