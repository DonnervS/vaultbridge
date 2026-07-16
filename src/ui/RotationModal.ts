import { App, Modal, Notice, Setting } from "obsidian";
import type VaultbridgePlugin from "../main";

/**
 * Modal "Passphrase ändern": fragt alte + neue Passphrase (mit Wiederholung)
 * ab, verschlüsselt beim Bestätigen alle Dateien neu (VaultbridgePlugin.rotatePassphrase)
 * und zeigt währenddessen den Fortschritt (done/total) samt Abbrechen-Button.
 */
export class RotationModal extends Modal {
  private oldPassphrase = "";
  private newPassphrase = "";
  private repeatPassphrase = "";
  private running = false;
  private controller: AbortController | null = null;
  private progressEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private confirmButton!: HTMLButtonElement;

  constructor(
    private readonly plugin: VaultbridgePlugin,
    app: App,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Vaultbridge: Passphrase ändern" });

    const warning = contentEl.createEl("p", {
      text:
        "Achtung: Dies verschlüsselt ALLE Dateien im Vault neu. Der Verlauf (Versionen) " +
        "von vor der Rotation bleibt mit der alten Passphrase verknüpft und ist auf diesem " +
        "Gerät danach nicht mehr lesbar. Der Vorgang kann bei vielen/großen Dateien einige Zeit dauern " +
        "— während dieser Zeit ist die Synchronisierung pausiert.",
      cls: "mod-warning",
    });
    warning.style.fontWeight = "bold";

    new Setting(contentEl).setName("Alte Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.oldPassphrase = v));
    });

    new Setting(contentEl).setName("Neue Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.newPassphrase = v));
    });

    new Setting(contentEl).setName("Neue Passphrase (Wiederholung)").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.repeatPassphrase = v));
    });

    this.progressEl = contentEl.createEl("p", { text: "" });

    this.actionsEl = contentEl.createDiv();
    new Setting(this.actionsEl)
      .addButton((b) => b.setButtonText("Abbrechen").onClick(() => this.close()))
      .addButton((b) => {
        this.confirmButton = b.buttonEl;
        b.setButtonText("Passphrase ändern")
          .setCta()
          .onClick(() => void this.startRotation());
      });
  }

  private async startRotation(): Promise<void> {
    if (this.running) return;
    if (!this.oldPassphrase) {
      new Notice("Vaultbridge: bitte die alte Passphrase eingeben.");
      return;
    }
    if (!this.newPassphrase) {
      new Notice("Vaultbridge: bitte eine neue Passphrase eingeben.");
      return;
    }
    if (this.newPassphrase !== this.repeatPassphrase) {
      new Notice("Vaultbridge: neue Passphrase und Wiederholung stimmen nicht überein.");
      return;
    }

    this.running = true;
    this.controller = new AbortController();
    this.confirmButton.disabled = true;
    this.renderProgress(0, 0);

    // Abbrechen-Button während der Rotation.
    this.actionsEl.empty();
    new Setting(this.actionsEl).addButton((b) =>
      b.setButtonText("Abbrechen").onClick(() => this.controller?.abort()),
    );

    try {
      const ok = await this.plugin.rotatePassphrase(
        this.oldPassphrase,
        this.newPassphrase,
        (done, total) => this.renderProgress(done, total),
        this.controller.signal,
      );
      if (ok) {
        new Notice(
          "Vaultbridge: Passphrase geändert. Verteile ggf. den neuen Setup-String an andere Geräte.",
        );
        this.close();
      } else {
        this.resetActions();
      }
    } catch (e) {
      if (this.controller.signal.aborted) {
        new Notice("Vaultbridge: Rotation abgebrochen.");
      } else {
        new Notice(`Vaultbridge: Rotation fehlgeschlagen: ${String(e)}`);
      }
      this.resetActions();
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  private resetActions(): void {
    this.actionsEl.empty();
    new Setting(this.actionsEl)
      .addButton((b) => b.setButtonText("Abbrechen").onClick(() => this.close()))
      .addButton((b) => {
        this.confirmButton = b.buttonEl;
        b.setButtonText("Passphrase ändern")
          .setCta()
          .onClick(() => void this.startRotation());
      });
  }

  private renderProgress(done: number, total: number): void {
    this.progressEl.setText(total > 0 ? `${done} / ${total}` : "");
  }

  onClose(): void {
    // Läuft gerade eine Rotation, wenn das Modal geschlossen wird (z.B. per
    // Escape), muss sie abgebrochen werden — sonst könnte ein zweites,
    // später gestartetes Modal eine parallele Rotation mit anderem
    // Schlüssel auslösen. store.rotate() ist abbrechbar; der Catch-Pfad in
    // rotatePassphrase() nimmt den Sync danach mit dem alten Schlüssel
    // wieder auf (der Ring heilt beim nächsten Resume selbst).
    if (this.running) this.controller?.abort();
    this.contentEl.empty();
  }
}
