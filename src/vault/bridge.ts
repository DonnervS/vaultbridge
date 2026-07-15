import { App, TAbstractFile, TFile, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { EchoGuard, contentHash, decideVaultAction } from "./applyChange";
import { FileMeta } from "../store/model";
import { SyncRules, shouldSync, isHidden } from "./rules";
import { listAllFiles } from "./adapterScan";
import { planHiddenSync } from "./hiddenSync";

// Sentinel-"Hash" für Löschungen: der Echo-Guard arbeitet sonst mit Inhalts-
// Hashes; eine Löschung hat keinen Inhalt, daher ein fester, kollisionsfreier Wert.
const DELETE_SENTINEL = "__vaultbridge_deleted__";

/**
 * Verbindet Obsidian-Vault-Ereignisse mit dem VaultStore in beide Richtungen:
 *  - lokale Datei-Events  -> Store  (ausgehend)
 *  - Store-Change-Feed    -> Vault  (eingehend, aus der Replikation), mit
 *    Echo-Guard + Inhalts-Hash-Vergleich gegen Endlosschleifen/Redundanz.
 */
export class VaultBridge {
  private readonly handlers: Array<() => void> = [];
  private incoming: { cancel(): void } | null = null;
  private reconcileRunning = false;
  private pendingHiddenDeletes = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly store: VaultStore,
    private readonly guard: EchoGuard,
    private readonly rules: SyncRules,
    private readonly getKnown: () => Map<string, string>,
    private readonly setKnown: (m: Map<string, string>) => void,
    private readonly onApplied?: (path: string) => void,
  ) {}

  start(): void {
    const vault = this.app.vault;

    const onLocalWrite = async (file: TFile) => {
      try {
        if (!shouldSync(file.path, this.rules)) return;
        const bytes = new Uint8Array(await vault.readBinary(file));
        if (this.guard.isEcho(file.path, await contentHash(bytes))) return; // eigene Remote-Schreibung
        await this.store.putFile(file.path, bytes, this.metaOf(file));
      } catch (e) {
        new Notice(`Vaultbridge: Sync-Fehler bei ${file.path}: ${String(e)}`);
      }
    };
    const onLocalDelete = async (file: TAbstractFile) => {
      try {
        if (!shouldSync(file.path, this.rules)) return;
        if (this.guard.isEcho(file.path, DELETE_SENTINEL)) return; // eigene Remote-Löschung
        await this.store.deleteFile(file.path);
      } catch (e) {
        new Notice(`Vaultbridge: Löschfehler bei ${file.path}: ${String(e)}`);
      }
    };

    const refCreate = vault.on("create", (f) => { if (f instanceof TFile) void onLocalWrite(f); });
    const refModify = vault.on("modify", (f) => { if (f instanceof TFile) void onLocalWrite(f); });
    const refDelete = vault.on("delete", (f) => void onLocalDelete(f));
    this.handlers.push(
      () => vault.offref(refCreate),
      () => vault.offref(refModify),
      () => vault.offref(refDelete),
    );

    // Eingehende Remote-Änderungen anwenden.
    this.incoming = this.store.subscribe((id) => void this.applyRemote(id));

    // Bestehende Dateien initial hochladen (Obsidian feuert für vorhandene
    // Dateien kein create-Event).
    void this.reconcileExisting();
  }

  private metaOf(file: TFile): FileMeta {
    return {
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      size: file.stat.size,
      mime: "",
      isBinary: !/^(md|txt|json|css|ya?ml)$/i.test(file.extension),
    };
  }

  private async reconcileExisting(): Promise<void> {
    for (const file of this.app.vault.getFiles()) {
      try {
        if (!shouldSync(file.path, this.rules)) continue;
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        const existing = await this.store.getFile(file.path);
        if (existing && (await contentHash(existing.bytes)) === (await contentHash(bytes))) {
          continue; // unverändert -> kein erneuter Upload (idempotent, kein Churn)
        }
        await this.store.putFile(file.path, bytes, this.metaOf(file));
      } catch (e) {
        new Notice(`Vaultbridge: Erst-Abgleich fehlgeschlagen bei ${file.path}: ${String(e)}`);
      }
    }
  }

  private async applyRemote(id: string): Promise<void> {
    try {
      const note = await this.store.readNote(id);
      if (!note) return;
      if (!shouldSync(note.path, this.rules)) return;

      if (isHidden(note.path)) {
        const adapter = this.app.vault.adapter;
        const exists = await adapter.exists(note.path);
        if (note.deleted) {
          if (exists) {
            this.guard.markApplied(note.path, DELETE_SENTINEL);
            await adapter.remove(note.path);
            this.onApplied?.(note.path);
          }
          this.updateKnown(note.path, null);
          return;
        }
        const targetHash = await contentHash(note.bytes);
        if (exists) {
          const current = new Uint8Array(await adapter.readBinary(note.path));
          const currentHash = await contentHash(current);
          if (currentHash === targetHash) { this.updateKnown(note.path, targetHash); return; }
          const knownHash = this.getKnown().get(note.path);
          if (knownHash === undefined || currentHash !== knownHash) {
            // Konkurrierende Änderung: die lokale (noch nicht synchronisierte) Version
            // in eine Sidecar-Datei sichern, damit sie nicht verloren geht; danach
            // gewinnt die Remote-Version (konsistent über alle Geräte).
            try {
              await adapter.writeBinary(`${note.path}.vaultbridge-konflikt`, current.slice().buffer as ArrayBuffer);
              new Notice(`Vaultbridge: konkurrierende Änderung an ${note.path}. Deine lokale Version wurde als ${note.path}.vaultbridge-konflikt gesichert.`);
            } catch { /* Sidecar ist best-effort */ }
          }
        }
        this.guard.markApplied(note.path, targetHash);
        await this.ensureParentAdapter(note.path);
        await adapter.writeBinary(note.path, note.bytes.slice().buffer as ArrayBuffer);
        this.updateKnown(note.path, targetHash);
        this.onApplied?.(note.path);
        return;
      }

      const vault = this.app.vault;
      const existing = vault.getAbstractFileByPath(note.path);
      const action = decideVaultAction(
        { path: note.path, deleted: note.deleted },
        existing instanceof TFile,
      );
      if (action === "delete" && existing instanceof TFile) {
        this.guard.markApplied(note.path, DELETE_SENTINEL);
        await vault.delete(existing);
        return;
      }
      if (action !== "write") return;

      const targetHash = await contentHash(note.bytes);
      // Obsidians modify/createBinary erwarten ArrayBuffer; slice() liefert eine
      // exakte, offset-freie Kopie -> sicher als ArrayBuffer.
      const ab = note.bytes.slice().buffer as ArrayBuffer;
      if (existing instanceof TFile) {
        const current = new Uint8Array(await vault.readBinary(existing));
        if ((await contentHash(current)) === targetHash) return; // schon in sync (auch lokaler Ursprung)
        this.guard.markApplied(note.path, targetHash);
        await vault.modifyBinary(existing, ab);
      } else {
        this.guard.markApplied(note.path, targetHash);
        await this.ensureParent(note.path);
        await vault.createBinary(note.path, ab);
      }
    } catch (e) {
      new Notice(`Vaultbridge: Anwenden fehlgeschlagen (${id}): ${String(e)}`);
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch { /* existiert bereits */ }
      }
    }
  }

  private updateKnown(path: string, hash: string | null): void {
    const known = this.getKnown();
    if (hash === null) known.delete(path); else known.set(path, hash);
    this.setKnown(known);
  }

  private async ensureParentAdapter(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await this.app.vault.adapter.exists(cur))) {
        try { await this.app.vault.adapter.mkdir(cur); } catch { /* existiert bereits */ }
      }
    }
  }

  /**
   * Gleicht versteckte Dateien (Dotfiles, .claude/, Plugins, …) ab, die nicht
   * über den indizierten Vault-API laufen und daher keine create/modify/delete-
   * Events auslösen — z.B. bereits vorhandene oder von außen (Sync-Client,
   * andere Tools) geänderte Dateien. Nutzt einen dreiseitigen Vergleich
   * (lokal / zuletzt bekannt / Store) analog reconcileExisting, aber über den
   * rohen Dateisystem-Adapter statt der Vault-API.
   */
  async reconcileHidden(): Promise<void> {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      try {
        const adapter = this.app.vault.adapter;
        const allPaths = await listAllFiles(adapter);
        const local = new Map<string, string>();
        const errored = new Set<string>();
        for (const path of allPaths) {
          if (!isHidden(path) || !shouldSync(path, this.rules)) continue;
          try {
            const bytes = new Uint8Array(await adapter.readBinary(path));
            local.set(path, await contentHash(bytes));
          } catch {
            // Datei wurde gelistet (existiert), ist aber gerade nicht lesbar
            // (Lock/TOCTOU) -> KEINE Löschung, diese Runde übergehen.
            errored.add(path);
          }
        }
        const storeAll = await this.store.pathHashes();
        const store = new Map<string, string>();
        for (const [p, h] of storeAll) if (isHidden(p) && shouldSync(p, this.rules)) store.set(p, h);
        const knownRaw = this.getKnown();
        const known = new Map<string, string>();
        for (const [p, h] of knownRaw) {
          if (isHidden(p) && shouldSync(p, this.rules) && !errored.has(p)) known.set(p, h);
        }
        const plan = planHiddenSync(local, known, store);
        for (const path of plan.uploads) {
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await adapter.readBinary(path));
          } catch {
            continue; // nicht lesbar -> diese Runde überspringen
          }
          const storeHash = store.get(path);
          const knownHash = knownRaw.get(path);
          if (storeHash !== undefined && knownHash !== undefined && storeHash !== knownHash) {
            // lokal UND remote seit letztem Sync geändert -> lokale Version sichern,
            // Upload überspringen (applyRemote hat/übernimmt die Remote-Version).
            try {
              await adapter.writeBinary(`${path}.vaultbridge-konflikt`, bytes.slice().buffer as ArrayBuffer);
              new Notice(`Vaultbridge: konkurrierende Änderung an ${path}. Lokale Version gesichert.`);
            } catch { /* best-effort */ }
            continue;
          }
          await this.store.putFile(path, bytes, {
            mtime: 0, ctime: 0, size: bytes.length, mime: "",
            isBinary: !/\.(md|txt|json|css|ya?ml|js)$/i.test(path),
          });
        }
        for (const path of plan.deleteRemotes) {
          if (this.pendingHiddenDeletes.has(path)) {
            await this.store.deleteFile(path);
            this.pendingHiddenDeletes.delete(path);
          } else {
            this.pendingHiddenDeletes.add(path); // erst in der nächsten Runde löschen
          }
        }
        // Pfade, die wieder aufgetaucht sind, aus der Warteschlange nehmen:
        for (const p of [...this.pendingHiddenDeletes]) if (local.has(p)) this.pendingHiddenDeletes.delete(p);
        const newKnown = new Map(local);
        for (const p of errored) {
          const prev = knownRaw.get(p);
          if (prev !== undefined) newKnown.set(p, prev);
        }
        for (const p of this.pendingHiddenDeletes) {
          const prev = knownRaw.get(p);
          if (prev !== undefined) newKnown.set(p, prev);
        }
        this.setKnown(newKnown); // Baseline = aktueller Plattenstand (Fehler behalten alten Stand)
      } catch (e) {
        new Notice(`Vaultbridge: Hidden-Abgleich fehlgeschlagen: ${String(e)}`);
      }
    } finally {
      this.reconcileRunning = false;
    }
  }

  stop(): void {
    for (const off of this.handlers) off();
    this.handlers.length = 0;
    this.incoming?.cancel();
    this.incoming = null;
  }
}
