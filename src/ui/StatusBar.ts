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

  constructor(private readonly el: HTMLElement) {
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
    const badge = this.conflicts > 0 ? `  ⚠️ ${this.conflicts} Konflikt${this.conflicts === 1 ? "" : "e"}` : "";
    this.el.setText(this.lastLabel + badge);
  }
}
