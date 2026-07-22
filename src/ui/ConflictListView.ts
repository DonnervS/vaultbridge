import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictSession } from "../conflicts/session";

export const VIEW_TYPE_CONFLICTS = "vaultbridge-conflicts";

/**
 * Konflikt-Ansicht als Master-Detail im Haupt-Editorbereich (volle Breite):
 * links die Liste aller Konflikte, rechts der GitHub-artige Side-by-Side-Diff
 * der gewählten Datei samt Auflösung. Ersetzt das frühere schmale Modal —
 * beide Versionen lassen sich so direkt nebeneinander vergleichen.
 */
export class ConflictListView extends ItemView {
  private selectedId: string | null = null;
  private applyWhole: ((side: "local" | "remote") => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly getStore: () => VaultStore | null) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CONFLICTS; }
  getDisplayText(): string { return "Vaultbridge-Konflikte"; }
  getIcon(): string { return "git-merge"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("vb-cv");

    const store = this.getStore();
    if (!store) {
      root.createEl("p", { text: "Nicht verbunden." });
      return;
    }
    const ids = await store.listConflicts();

    // Linke Spalte: Konfliktliste.
    const listPane = root.createDiv({ cls: "vb-cv-list" });
    listPane.createEl("div", { cls: "vb-cv-list-head", text: `Konflikte (${ids.length})` });
    if (ids.length === 0) {
      listPane.createEl("p", { cls: "vb-cv-empty", text: "Keine Konflikte 🎉" });
      this.selectedId = null;
    } else {
      // Auswahl beibehalten, sofern noch vorhanden; sonst den ersten Konflikt zeigen.
      if (!this.selectedId || !ids.includes(this.selectedId)) this.selectedId = ids[0];
      for (const id of ids) {
        const conflict = await store.getConflict(id);
        const label = conflict?.path ?? id;
        const item = listPane.createEl("button", { cls: "vb-cv-item", text: label });
        item.toggleClass("vb-cv-active", id === this.selectedId);
        item.onclick = () => { this.selectedId = id; void this.render(); };
      }
    }

    // Rechte Spalte: Detail/Diff der ausgewählten Datei.
    const detail = root.createDiv({ cls: "vb-cv-detail" });
    if (this.selectedId) {
      await this.renderDetail(detail, store, this.selectedId);
    } else {
      detail.createEl("p", { cls: "vb-cv-hint", text: "Kein Konflikt ausgewählt." });
    }
  }

  private async renderDetail(root: HTMLElement, store: VaultStore, id: string): Promise<void> {
    const conflict = await store.getConflict(id);
    if (!conflict || conflict.remotes.length === 0) {
      root.createEl("p", { text: "Kein Konflikt mehr vorhanden." });
      this.selectedId = null;
      return;
    }

    const header = root.createDiv({ cls: "vb-cv-detail-head" });
    header.createEl("div", { cls: "vb-cv-path", text: conflict.path });
    header.createEl("div", {
      cls: "vb-cv-note",
      text: "„Aktuell“ ist die derzeit gültige Version, „Konflikt“ die abweichende. Wähle nach dem Inhalt, nicht nach dem Gerät.",
    });

    const session = new ConflictSession({
      id: conflict.id,
      path: conflict.path,
      isBinary: conflict.isBinary,
      local: { rev: conflict.local.rev, bytes: conflict.local.bytes },
      remote: { rev: conflict.remotes[0].rev, bytes: conflict.remotes[0].bytes },
    });

    const body = root.createDiv({ cls: "vb-cv-body" });
    if (conflict.isBinary) {
      this.renderBinary(body, session, conflict);
    } else {
      this.renderDiff(body, session);
    }

    const footer = root.createDiv({ cls: "vb-cv-footer" });
    footer.createEl("button", { cls: "vb-btn-local", text: "⬅ Ganz „Aktuell“" }).onclick = () => this.applyWhole?.("local");
    footer.createEl("button", { cls: "vb-btn-remote", text: "Ganz „Konflikt“ ➡" }).onclick = () => this.applyWhole?.("remote");
    const save = footer.createEl("button", { text: "Zusammenführen & speichern" });
    save.addClass("mod-cta");
    save.onclick = async () => {
      try {
        await store.resolveConflict(
          conflict.id,
          conflict.path,
          session.resultBytes(),
          conflict.local.meta,
          [session.pruneRev()],
        );
        new Notice(`Konflikt gelöst: ${conflict.path}`);
        this.selectedId = null; // gelöst -> nächsten (ersten verbleibenden) zeigen
        void this.render();
      } catch (e) {
        new Notice(`Vaultbridge: Konflikt konnte nicht gelöst werden: ${String(e)}`);
      }
    };
  }

  /**
   * GitHub-artiger Side-by-Side-Diff: links „Aktuell“ (entfernte Zeilen rot mit
   * „−“), rechts „Konflikt“ (hinzugefügte Zeilen grün mit „+“), gemeinsame Zeilen
   * neutral. Jede visuelle Zeile trägt ihre Zeilennummer; die beiden Seiten sind
   * pro Zeile aneinander ausgerichtet. Pro Änderungsblock wählt man, welche Seite
   * ins Ergebnis übernommen wird.
   */
  private renderDiff(root: HTMLElement, session: ConflictSession): void {
    const table = root.createDiv({ cls: "vb-diff" });

    const colHead = table.createDiv({ cls: "vb-diff-head" });
    colHead.createDiv({ cls: "vb-diff-head-cell vb-side-local", text: "Aktuell (gültig)" });
    colHead.createDiv({ cls: "vb-diff-head-cell vb-side-remote", text: "Konflikt (abweichend)" });

    let lnLocal = 0;
    let lnRemote = 0;
    let changeIdx = 0;
    const hunkMarks: Array<(side: "local" | "remote") => void> = [];

    const strip = (s: string): string => s.replace(/\n$/, "");

    // Eine Diff-Zeile (zwei Seiten) mit optionalen Zeilennummern + Zeichen bauen.
    const addRow = (
      parent: HTMLElement,
      left: { n?: number; text?: string; sign?: string; kind: "eq" | "del" | "empty" },
      right: { n?: number; text?: string; sign?: string; kind: "eq" | "add" | "empty" },
    ): void => {
      const row = parent.createDiv({ cls: "vb-drow" });
      const paneL = row.createDiv({ cls: `vb-pane vb-pane-l vb-${left.kind}` });
      paneL.createSpan({ cls: "vb-ln", text: left.n !== undefined ? String(left.n) : "" });
      paneL.createSpan({ cls: "vb-sign", text: left.sign ?? "" });
      paneL.createSpan({ cls: "vb-code", text: left.text ?? "" });
      const paneR = row.createDiv({ cls: `vb-pane vb-pane-r vb-${right.kind}` });
      paneR.createSpan({ cls: "vb-ln", text: right.n !== undefined ? String(right.n) : "" });
      paneR.createSpan({ cls: "vb-sign", text: right.sign ?? "" });
      paneR.createSpan({ cls: "vb-code", text: right.text ?? "" });
    };

    for (const hunk of session.hunks) {
      if (hunk.kind === "equal") {
        for (const line of hunk.lines) {
          lnLocal++; lnRemote++;
          addRow(
            table,
            { n: lnLocal, text: strip(line), kind: "eq" },
            { n: lnRemote, text: strip(line), kind: "eq" },
          );
        }
        continue;
      }

      // Änderungsblock: eigener Wrapper mit Auswahl-Kopf.
      const idx = changeIdx++;
      const block = table.createDiv({ cls: "vb-hunk" });
      block.dataset.chosen = "local";

      const bar = block.createDiv({ cls: "vb-hunk-bar" });
      bar.createSpan({ cls: "vb-hunk-label", text: "Geänderter Abschnitt — Seite wählen:" });
      const pick = (chosen: "local" | "remote") => { block.dataset.chosen = chosen; };
      const btnL = bar.createEl("button", { cls: "vb-btn-local", text: "⬅ Aktuell" });
      const btnR = bar.createEl("button", { cls: "vb-btn-remote", text: "Konflikt ➡" });
      btnL.onclick = () => { session.setDecision(idx, "local"); pick("local"); };
      btnR.onclick = () => { session.setDecision(idx, "remote"); pick("remote"); };
      hunkMarks.push(pick);

      const rows = block.createDiv({ cls: "vb-hunk-rows" });
      const max = Math.max(hunk.local.length, hunk.remote.length);
      for (let i = 0; i < max; i++) {
        const l = i < hunk.local.length ? hunk.local[i] : null;
        const r = i < hunk.remote.length ? hunk.remote[i] : null;
        if (l !== null) lnLocal++;
        if (r !== null) lnRemote++;
        addRow(
          rows,
          l !== null
            ? { n: lnLocal, text: strip(l), sign: "−", kind: "del" }
            : { kind: "empty" },
          r !== null
            ? { n: lnRemote, text: strip(r), sign: "+", kind: "add" }
            : { kind: "empty" },
        );
      }
    }

    this.applyWhole = (side) => {
      session.takeWhole(side);
      hunkMarks.forEach((m) => m(side));
    };
  }

  private renderBinary(
    root: HTMLElement,
    session: ConflictSession,
    conflict: { local: { bytes: Uint8Array }; remotes: { bytes: Uint8Array }[] },
  ): void {
    root.createEl("p", { text: "Binärdatei — kein Textvergleich möglich. Version wählen:" });
    const cards = root.createDiv({ cls: "vb-binary" });
    const local = cards.createDiv({ cls: "vb-card vb-chosen" });
    local.createEl("b", { text: "Aktuell (gültig)" });
    local.createEl("div", { text: `${conflict.local.bytes.length} Bytes` });
    const remote = cards.createDiv({ cls: "vb-card" });
    remote.createEl("b", { text: "Konfliktversion" });
    remote.createEl("div", { text: `${conflict.remotes[0].bytes.length} Bytes` });
    local.onclick = () => { session.takeWhole("local"); local.addClass("vb-chosen"); remote.removeClass("vb-chosen"); };
    remote.onclick = () => { session.takeWhole("remote"); remote.addClass("vb-chosen"); local.removeClass("vb-chosen"); };
    this.applyWhole = (side) => {
      session.takeWhole(side);
      local.toggleClass("vb-chosen", side === "local");
      remote.toggleClass("vb-chosen", side === "remote");
    };
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
