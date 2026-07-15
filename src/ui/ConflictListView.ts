import { ItemView, WorkspaceLeaf } from "obsidian";
import { VaultStore } from "../store/store";
import { ConflictResolverModal } from "./ConflictResolverModal";

export const VIEW_TYPE_CONFLICTS = "vaultbridge-conflicts";

export class ConflictListView extends ItemView {
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
    root.createEl("h3", { text: "Konflikte" });
    const store = this.getStore();
    if (!store) {
      root.createEl("p", { text: "Nicht verbunden." });
      return;
    }
    const ids = await store.listConflicts();
    if (ids.length === 0) {
      root.createEl("p", { text: "Keine Konflikte 🎉" });
      return;
    }
    const list = root.createEl("ul");
    for (const id of ids) {
      const conflict = await store.getConflict(id);
      if (!conflict) continue;
      const li = list.createEl("li");
      const btn = li.createEl("button", { text: conflict.path });
      btn.onclick = () => {
        new ConflictResolverModal(this.app, store, id, () => void this.render()).open();
      };
    }
  }
}
