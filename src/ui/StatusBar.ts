import { SyncStatus } from "../store/replication";

const LABELS: Record<SyncStatus, string> = {
  idle: "🟢 Vaultbridge: aktuell",
  active: "🔵 Vaultbridge: synct …",
  paused: "🟢 Vaultbridge: bereit",
  error: "🔴 Vaultbridge: Fehler",
};

export class StatusBar {
  constructor(private readonly el: HTMLElement) {
    this.el.setText("⚪ Vaultbridge: inaktiv");
  }
  setStatus(status: SyncStatus, info?: string): void {
    this.el.setText(LABELS[status] + (status === "error" && info ? ` (${info})` : ""));
  }
}
