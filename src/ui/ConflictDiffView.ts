import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictSession } from "../conflicts/session";

export const VIEW_TYPE_CONFLICT_DIFF = "vaultbridge-conflict-diff";

/**
 * Zeigt den Vergleich EINER Konfliktdatei im Haupt-Editorbereich (volle Breite),
 * GitHub-artig Seite an Seite. Bewusst getrennt von der Konfliktliste: der Diff
 * wird nur bei Auswahl/Auflösung neu gebaut, nicht bei jedem Sync-Event — sonst
 * würde die Ansicht (und die gerade getroffene Auswahl) unter den Fingern
 * zurückgesetzt.
 */
export class ConflictDiffView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getStore: () => VaultStore | null,
    private readonly getActiveId: () => string | null,
    private readonly onResolved: (resolvedId: string) => void,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CONFLICT_DIFF; }
  getDisplayText(): string { return "Konflikt-Vergleich"; }
  getIcon(): string { return "git-compare"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("vb-cv-detail");

    const store = this.getStore();
    if (!store) { root.createEl("p", { cls: "vb-cv-hint", text: "Nicht verbunden." }); return; }

    const id = this.getActiveId();
    if (!id) {
      root.createEl("p", { cls: "vb-cv-hint", text: "Wähle links einen Konflikt aus." });
      return;
    }
    const conflict = await store.getConflict(id);
    if (!conflict || conflict.remotes.length === 0) {
      root.createEl("p", { cls: "vb-cv-hint", text: "Dieser Konflikt ist bereits gelöst. Wähle links einen anderen." });
      return;
    }

    const header = root.createDiv({ cls: "vb-cv-detail-head" });
    header.createEl("div", { cls: "vb-cv-path", text: conflict.path });

    const session = new ConflictSession({
      id: conflict.id,
      path: conflict.path,
      isBinary: conflict.isBinary,
      local: { rev: conflict.local.rev, bytes: conflict.local.bytes },
      remote: { rev: conflict.remotes[0].rev, bytes: conflict.remotes[0].bytes },
    });

    const identical = !conflict.isBinary && session.hunks.every((h) => h.kind === "equal");
    header.createEl("div", {
      cls: "vb-cv-note",
      text: identical
        ? "Beide Versionen sind inhaltlich identisch — „Konflikt auflösen“ genügt (es geht nichts verloren)."
        : conflict.isBinary
          ? "Binärdatei — wähle unten, welche Version behalten werden soll."
          : "Unten kannst du komplett eine Seite übernehmen — oder pro Abschnitt eine Seite wählen und beide zu einer Fassung zusammenführen.",
    });

    const body = root.createDiv({ cls: "vb-cv-body" });
    const footer = root.createDiv({ cls: "vb-cv-footer" });

    // Binärdatei: nur ganze Seite übernehmen (kein Textmerge).
    if (conflict.isBinary) {
      this.renderBinary(body, conflict);
      footer.createEl("button", { cls: "vb-btn-local", text: "⬅ Ganz „Aktuell“ behalten" })
        .onclick = () => void this.saveWhole(store, conflict, session, "local");
      footer.createEl("button", { cls: "vb-btn-remote", text: "Ganz „Konflikt“ übernehmen ➡" })
        .onclick = () => void this.saveWhole(store, conflict, session, "remote");
      return;
    }
    // Inhaltlich identisch: ein Klick genügt.
    if (identical) {
      body.createDiv({ cls: "vb-cv-identical", text: "Kein inhaltlicher Unterschied zwischen den beiden Versionen." });
      const resolve = footer.createEl("button", { text: "Konflikt auflösen" });
      resolve.addClass("mod-cta");
      resolve.onclick = () => void this.saveWhole(store, conflict, session, "local");
      return;
    }

    // Textkonflikt mit Unterschieden. Zwei Schritte, umschaltbar ohne die
    // getroffene Auswahl (session.decisions) zu verlieren — deshalb nur body+
    // footer neu befüllen statt die ganze View (samt session) neu zu bauen:
    //  1. Auswahl: Side-by-Side, pro Abschnitt eine Seite wählen. „Ganz Aktuell“/
    //     „Ganz Konflikt“ übernehmen sofort komplett eine Seite.
    //  2. Vorschau: die zusammengeführte Endfassung ansehen und übernehmen.
    const showDiff = (): void => {
      body.empty(); footer.empty();
      this.renderDiff(body, session);
      footer.createEl("button", { cls: "vb-btn-local", text: "⬅ Ganz „Aktuell“ behalten" })
        .onclick = () => void this.saveWhole(store, conflict, session, "local");
      footer.createEl("button", { cls: "vb-btn-remote", text: "Ganz „Konflikt“ übernehmen ➡" })
        .onclick = () => void this.saveWhole(store, conflict, session, "remote");
      const preview = footer.createEl("button", { text: "Zusammenführen (Vorschau) →" });
      preview.addClass("mod-cta");
      preview.onclick = () => showPreview();
    };
    const showPreview = (): void => {
      body.empty(); footer.empty();
      this.renderMergePreview(body, session);
      footer.createEl("button", { text: "← Zurück zur Auswahl" }).onclick = () => showDiff();
      const apply = footer.createEl("button", { text: "✓ Diese Fassung übernehmen & speichern" });
      apply.addClass("mod-cta");
      apply.onclick = () => void this.save(store, conflict, session);
    };
    showDiff();
  }

  /**
   * Vorschau der zusammengeführten Endfassung: die tatsächlich resultierende
   * Datei Zeile für Zeile, wobei aus einem Konfliktabschnitt übernommene Zeilen
   * farblich markiert sind (Aktuell/Konflikt). So sieht man vor dem Speichern,
   * was herauskommt.
   */
  private renderMergePreview(root: HTMLElement, session: ConflictSession): void {
    root.createDiv({
      cls: "vb-merge-note",
      text: "Vorschau der zusammengeführten Datei. Markierte Zeilen stammen aus einem Konfliktabschnitt (blau = Aktuell, grün = Konflikt).",
    });
    const table = root.createDiv({ cls: "vb-merge" });
    const strip = (s: string): string => s.replace(/\n$/, "");
    let n = 0;
    for (const line of session.mergePreview()) {
      n++;
      const row = table.createDiv({ cls: `vb-mrow vb-from-${line.origin}` });
      row.createSpan({ cls: "vb-ln", text: String(n) });
      row.createSpan({
        cls: "vb-tag",
        text: line.origin === "local" ? "Aktuell" : line.origin === "remote" ? "Konflikt" : "",
      });
      row.createSpan({ cls: "vb-code", text: strip(line.text) });
    }
  }

  /** Komplett eine Seite übernehmen und sofort speichern. */
  private async saveWhole(
    store: VaultStore,
    conflict: { id: string; path: string; local: { meta: import("../store/model").FileMeta } },
    session: ConflictSession,
    side: "local" | "remote",
  ): Promise<void> {
    session.takeWhole(side);
    await this.save(store, conflict, session);
  }

  private async save(
    store: VaultStore,
    conflict: { id: string; path: string; local: { meta: import("../store/model").FileMeta } },
    session: ConflictSession,
  ): Promise<void> {
    try {
      await store.resolveConflict(
        conflict.id,
        conflict.path,
        session.resultBytes(),
        conflict.local.meta,
        [session.pruneRev()],
      );
      new Notice(`Konflikt gelöst: ${conflict.path}`);
      this.onResolved(conflict.id);
    } catch (e) {
      new Notice(`Vaultbridge: Konflikt konnte nicht gelöst werden: ${String(e)}`);
    }
  }

  private renderDiff(root: HTMLElement, session: ConflictSession): void {
    const table = root.createDiv({ cls: "vb-diff" });

    const colHead = table.createDiv({ cls: "vb-diff-head" });
    colHead.createDiv({ cls: "vb-diff-head-cell vb-side-local", text: "Aktuell (gültig)" });
    colHead.createDiv({ cls: "vb-diff-head-cell vb-side-remote", text: "Konflikt (abweichend)" });

    let lnLocal = 0;
    let lnRemote = 0;
    let changeIdx = 0;
    const strip = (s: string): string => s.replace(/\n$/, "");

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
          addRow(table, { n: lnLocal, text: strip(line), kind: "eq" }, { n: lnRemote, text: strip(line), kind: "eq" });
        }
        continue;
      }
      const idx = changeIdx++;
      const block = table.createDiv({ cls: "vb-hunk" });
      block.dataset.chosen = "local";

      const bar = block.createDiv({ cls: "vb-hunk-bar" });
      bar.createSpan({ cls: "vb-hunk-label", text: "Geänderter Abschnitt — Seite wählen:" });
      const pick = (chosen: "local" | "remote") => { block.dataset.chosen = chosen; };
      bar.createEl("button", { cls: "vb-btn-local", text: "⬅ Aktuell" }).onclick = () => { session.setDecision(idx, "local"); pick("local"); };
      bar.createEl("button", { cls: "vb-btn-remote", text: "Konflikt ➡" }).onclick = () => { session.setDecision(idx, "remote"); pick("remote"); };

      const rows = block.createDiv({ cls: "vb-hunk-rows" });
      const max = Math.max(hunk.local.length, hunk.remote.length);
      for (let i = 0; i < max; i++) {
        const l = i < hunk.local.length ? hunk.local[i] : null;
        const r = i < hunk.remote.length ? hunk.remote[i] : null;
        if (l !== null) lnLocal++;
        if (r !== null) lnRemote++;
        addRow(
          rows,
          l !== null ? { n: lnLocal, text: strip(l), sign: "−", kind: "del" } : { kind: "empty" },
          r !== null ? { n: lnRemote, text: strip(r), sign: "+", kind: "add" } : { kind: "empty" },
        );
      }
    }
  }

  private renderBinary(
    root: HTMLElement,
    conflict: { local: { bytes: Uint8Array }; remotes: { bytes: Uint8Array }[] },
  ): void {
    const cards = root.createDiv({ cls: "vb-binary" });
    const local = cards.createDiv({ cls: "vb-card" });
    local.createEl("b", { text: "Aktuell (gültig)" });
    local.createEl("div", { text: `${conflict.local.bytes.length} Bytes` });
    const remote = cards.createDiv({ cls: "vb-card" });
    remote.createEl("b", { text: "Konfliktversion" });
    remote.createEl("div", { text: `${conflict.remotes[0].bytes.length} Bytes` });
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
