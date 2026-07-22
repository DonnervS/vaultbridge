import { SyncStatus } from "../store/replication";

const LABELS: Record<SyncStatus, string> = {
  idle: "🟢 Vaultbridge: aktuell",
  active: "🔵 Vaultbridge: synct …",
  paused: "🟢 Vaultbridge: bereit",
  error: "🔴 Vaultbridge: Fehler",
};

export class StatusBar {
  private lastLabel = "⚪ Vaultbridge: inaktiv";
  private conflicts = 0;

  /**
   * @param onConflictClick Klick auf das Konflikt-Badge (öffnet die
   *   Konflikt-Ansicht). Ohne Callback bleibt das Badge nicht klickbar.
   */
  constructor(private readonly el: HTMLElement, private readonly onConflictClick?: () => void) {
    this.render();
  }

  setStatus(status: SyncStatus, info?: string): void {
    this.lastLabel = LABELS[status] + (status === "error" && info ? ` (${info})` : "");
    this.render();
  }

  setInactive(): void {
    this.lastLabel = "⚪ Vaultbridge: inaktiv";
    this.conflicts = 0;
    this.render();
  }

  setConflicts(count: number): void {
    this.conflicts = count;
    this.render();
  }

  private render(): void {
    this.el.empty();
    this.el.createSpan({ text: this.lastLabel });
    if (this.conflicts > 0) {
      const badge = this.el.createSpan({
        cls: "vb-status-conflicts",
        text: `⚠️ ${this.conflicts} Konflikt${this.conflicts === 1 ? "" : "e"}`,
      });
      if (this.onConflictClick) {
        badge.addClass("vb-clickable");
        badge.setAttr("aria-label", "Konflikte anzeigen");
        badge.onclick = () => this.onConflictClick!();
      }
    }
  }
}
