import { App, Modal, Notice } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictSession } from "../conflicts/session";

export class ConflictResolverModal extends Modal {
  private applyWhole: ((side: "local" | "remote") => void) | null = null;

  constructor(
    app: App,
    private readonly store: VaultStore,
    private readonly noteId: string,
    private readonly onResolved: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const conflict = await this.store.getConflict(this.noteId);
    if (!conflict || conflict.remotes.length === 0) {
      contentEl.setText("Kein Konflikt mehr vorhanden.");
      this.onResolved();
      return;
    }
    contentEl.createEl("h3", { text: `Konflikt: ${conflict.path}` });
    const session = new ConflictSession({
      id: conflict.id,
      path: conflict.path,
      isBinary: conflict.isBinary,
      local: { rev: conflict.local.rev, bytes: conflict.local.bytes },
      remote: { rev: conflict.remotes[0].rev, bytes: conflict.remotes[0].bytes },
    });

    if (conflict.isBinary) {
      this.renderBinary(contentEl, session, conflict);
    } else {
      this.renderDiff(contentEl, session);
    }

    const footer = contentEl.createDiv({ cls: "vb-conflict-footer" });
    footer.createEl("button", { text: "Ganz lokal" }).onclick = () => this.applyWhole?.("local");
    footer.createEl("button", { text: "Ganz remote" }).onclick = () => this.applyWhole?.("remote");
    const save = footer.createEl("button", { text: "Zusammenführen & speichern" });
    save.addClass("mod-cta");
    save.onclick = async () => {
      try {
        await this.store.resolveConflict(
          conflict.id,
          conflict.path,
          session.resultBytes(),
          conflict.local.meta,
          [session.pruneRev()],
        );
        new Notice(`Konflikt gelöst: ${conflict.path}`);
        this.onResolved();
        this.close();
      } catch (e) {
        new Notice(`Vaultbridge: Konflikt konnte nicht gelöst werden: ${String(e)}`);
      }
    };
  }

  private renderDiff(root: HTMLElement, session: ConflictSession): void {
    const table = root.createDiv({ cls: "vb-diff" });
    let changeIdx = 0;
    const rowMarks: Array<(side: "local" | "remote") => void> = [];
    for (const hunk of session.hunks) {
      if (hunk.kind === "equal") {
        const row = table.createDiv({ cls: "vb-diff-row vb-equal" });
        row.createDiv({ cls: "vb-col", text: hunk.lines.join("") });
        row.createDiv({ cls: "vb-col", text: hunk.lines.join("") });
      } else {
        const idx = changeIdx++;
        const row = table.createDiv({ cls: "vb-diff-row vb-change" });
        const left = row.createDiv({ cls: "vb-col vb-local", text: hunk.local.join("") || "(leer)" });
        const right = row.createDiv({ cls: "vb-col vb-remote", text: hunk.remote.join("") || "(leer)" });
        const mark = (chosen: "local" | "remote") => {
          left.toggleClass("vb-chosen", chosen === "local");
          right.toggleClass("vb-chosen", chosen === "remote");
        };
        mark("local");
        rowMarks.push(mark);
        left.createEl("button", { text: "← übernehmen" }).onclick = () => { session.setDecision(idx, "local"); mark("local"); };
        right.createEl("button", { text: "übernehmen →" }).onclick = () => { session.setDecision(idx, "remote"); mark("remote"); };
      }
    }
    this.applyWhole = (side) => {
      session.takeWhole(side);
      rowMarks.forEach((m) => m(side));
    };
  }

  private renderBinary(
    root: HTMLElement,
    session: ConflictSession,
    conflict: { local: { bytes: Uint8Array; meta: { size: number } }; remotes: { bytes: Uint8Array; meta: { size: number } }[] },
  ): void {
    root.createEl("p", { text: "Binärdatei — kein Textvergleich möglich. Version wählen:" });
    const cards = root.createDiv({ cls: "vb-binary" });
    const local = cards.createDiv({ cls: "vb-card vb-chosen" });
    local.createEl("b", { text: "Lokal" });
    local.createEl("div", { text: `${conflict.local.bytes.length} Bytes` });
    const remote = cards.createDiv({ cls: "vb-card" });
    remote.createEl("b", { text: "Remote" });
    remote.createEl("div", { text: `${conflict.remotes[0].bytes.length} Bytes` });
    local.onclick = () => { session.takeWhole("local"); local.addClass("vb-chosen"); remote.removeClass("vb-chosen"); };
    remote.onclick = () => { session.takeWhole("remote"); remote.addClass("vb-chosen"); local.removeClass("vb-chosen"); };
    this.applyWhole = (side) => {
      session.takeWhole(side);
      local.toggleClass("vb-chosen", side === "local");
      remote.toggleClass("vb-chosen", side === "remote");
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
