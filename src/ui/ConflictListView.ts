import { ItemView, WorkspaceLeaf } from "obsidian";
import { VaultStore } from "../store/store";

export const VIEW_TYPE_CONFLICTS = "vaultbridge-conflicts";

/**
 * Konfliktliste in der rechten Seitenleiste (nur die Dateinamen). Ein Klick
 * öffnet den Vergleich im Haupt-Editorbereich (ConflictDiffView) — die Liste
 * bleibt dabei stehen und darf sich unabhängig aktualisieren (Sync-Events),
 * ohne den gerade offenen Diff neu aufzubauen.
 */
export class ConflictListView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getStore: () => VaultStore | null,
    private readonly onPick: (id: string) => void,
    private readonly getActiveId: () => string | null,
    private readonly onResolveIdentical: () => void,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CONFLICTS; }
  getDisplayText(): string { return "Vaultbridge-Konflikte"; }
  getIcon(): string { return "git-merge"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("vb-cv-list");
    root.createEl("div", { cls: "vb-cv-list-head", text: "Konflikte" });

    const store = this.getStore();
    if (!store) {
      root.createEl("p", { cls: "vb-cv-empty", text: "Nicht verbunden." });
      return;
    }
    const ids = await store.listConflicts();
    root.querySelector(".vb-cv-list-head")!.setText(`Konflikte (${ids.length})`);
    if (ids.length === 0) {
      root.createEl("p", { cls: "vb-cv-empty", text: "Keine Konflikte 🎉" });
      return;
    }

    // Sammel-Auflösung für die häufigen „unechten“ Konflikte (identischer Inhalt,
    // nur divergierende Revisionen) — spart das Einzeln-Durchklicken.
    const resolveBtn = root.createEl("button", { cls: "vb-cv-resolve-all", text: "Identische auflösen" });
    resolveBtn.onclick = () => this.onResolveIdentical();

    const activeId = this.getActiveId();
    for (const id of ids) {
      const conflict = await store.getConflict(id);
      const path = conflict?.path ?? id;
      const item = root.createDiv({ cls: "vb-cv-item" });
      item.toggleClass("vb-cv-active", id === activeId);
      // Pfad in Ordner + Dateiname aufteilen, damit lange Pfade sauber umbrechen
      // und der Dateiname hervorsticht (statt aus der Box zu laufen).
      const slash = path.lastIndexOf("/");
      if (slash >= 0) {
        item.createDiv({ cls: "vb-cv-item-dir", text: path.slice(0, slash + 1) });
      }
      item.createDiv({ cls: "vb-cv-item-name", text: slash >= 0 ? path.slice(slash + 1) : path });
      item.onclick = () => this.onPick(id);
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
