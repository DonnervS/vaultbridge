import { App, Modal, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { computeHunks } from "../conflicts/diff";
import { utf8 } from "../crypto/encoding";

export class HistoryModal extends Modal {
  constructor(
    private readonly store: VaultStore,
    private readonly noteId: string,
    private readonly displayPath: string,
    private readonly onRestored: () => void,
    app: App,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Verlauf: ${this.displayPath}` });
    const revs = await this.store.listRevisions(this.noteId);
    if (revs.length <= 1) {
      contentEl.createEl("p", { text: "Keine früheren Versionen vorhanden." });
      return;
    }
    const current = revs[0].bytes;
    const list = contentEl.createDiv({ cls: "vb-history-list" });
    const detail = contentEl.createDiv({ cls: "vb-history-detail" });

    revs.forEach((rev, i) => {
      const item = list.createEl("button", {
        text: i === 0 ? "Aktuelle Version" : `Version ${revs.length - i} (${rev.bytes.length} B)`,
      });
      if (i === 0) item.addClass("mod-cta");
      item.onclick = () => this.showRevision(detail, current, rev, i === 0);
    });
    this.showRevision(detail, current, revs[1], false); // vorherige Version vorwählen
  }

  private showRevision(
    root: HTMLElement,
    current: Uint8Array,
    rev: { rev: string; bytes: Uint8Array },
    isCurrent: boolean,
  ): void {
    root.empty();
    if (isCurrent) {
      root.createEl("p", { text: "Das ist die aktuelle Version." });
      return;
    }
    // read-only Zweispalt-Diff: alt (links) vs. aktuell (rechts)
    const hunks = computeHunks(utf8.decode(rev.bytes), utf8.decode(current));
    const table = root.createDiv({ cls: "vb-diff" });
    for (const h of hunks) {
      const row = table.createDiv({ cls: "vb-diff-row" + (h.kind === "change" ? " vb-change" : "") });
      if (h.kind === "equal") {
        row.createDiv({ cls: "vb-col", text: h.lines.join("") });
        row.createDiv({ cls: "vb-col", text: h.lines.join("") });
      } else {
        row.createDiv({ cls: "vb-col vb-local", text: h.local.join("") || "(leer)" });
        row.createDiv({ cls: "vb-col vb-remote", text: h.remote.join("") || "(leer)" });
      }
    }
    const restore = root.createEl("button", { text: "Diese Version wiederherstellen" });
    restore.addClass("mod-cta");
    restore.onclick = async () => {
      try {
        await this.store.restoreRevision(this.noteId, rev.rev);
        new Notice(`Version von ${this.displayPath} wiederhergestellt.`);
        this.onRestored();
        this.close();
      } catch (e) {
        new Notice(`Vaultbridge: Wiederherstellen fehlgeschlagen: ${String(e)}`);
      }
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
