import { App, TAbstractFile, TFile, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { EchoGuard, contentHash, decideVaultAction } from "./applyChange";
import { FileMeta } from "../store/model";

/**
 * Verbindet Obsidian-Vault-Ereignisse mit dem VaultStore in beide Richtungen:
 *  - lokale Datei-Events  -> Store  (ausgehend)
 *  - Store-Change-Feed    -> Vault  (eingehend, aus der Replikation), mit
 *    Echo-Guard + Inhalts-Hash-Vergleich gegen Endlosschleifen/Redundanz.
 */
export class VaultBridge {
  private readonly handlers: Array<() => void> = [];
  private incoming: { cancel(): void } | null = null;

  constructor(
    private readonly app: App,
    private readonly store: VaultStore,
    private readonly guard: EchoGuard,
  ) {}

  start(): void {
    const vault = this.app.vault;

    const onLocalWrite = async (file: TFile) => {
      try {
        const bytes = new Uint8Array(await vault.readBinary(file));
        if (this.guard.isEcho(file.path, await contentHash(bytes))) return; // eigene Remote-Schreibung
        const meta: FileMeta = {
          mtime: file.stat.mtime,
          ctime: file.stat.ctime,
          size: file.stat.size,
          mime: "",
          isBinary: !/^(md|txt|json|css|ya?ml)$/i.test(file.extension),
        };
        await this.store.putFile(file.path, bytes, meta);
      } catch (e) {
        new Notice(`Vaultbridge: Sync-Fehler bei ${file.path}: ${String(e)}`);
      }
    };
    const onLocalDelete = async (file: TAbstractFile) => {
      try {
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
  }

  private async applyRemote(id: string): Promise<void> {
    try {
      const note = await this.store.readNote(id);
      if (!note) return;
      const vault = this.app.vault;
      const existing = vault.getAbstractFileByPath(note.path);
      const action = decideVaultAction(
        { path: note.path, deleted: note.deleted },
        existing instanceof TFile,
      );
      if (action === "delete" && existing instanceof TFile) {
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

  stop(): void {
    for (const off of this.handlers) off();
    this.handlers.length = 0;
    this.incoming?.cancel();
    this.incoming = null;
  }
}
