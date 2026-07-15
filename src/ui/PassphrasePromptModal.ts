import { App, Modal, Setting } from "obsidian";

/**
 * Plattformübergreifende Passphrase-Abfrage (funktioniert auch auf Mobile,
 * anders als window.prompt). Löst mit der eingegebenen Passphrase auf oder
 * mit null, wenn abgebrochen wurde.
 */
class PassphrasePromptModal extends Modal {
  private value = "";
  private submitted = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly resolve: (value: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });

    new Setting(contentEl).addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("Passphrase");
      text.onChange((v) => (this.value = v));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Abbrechen").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Bestätigen").setCta().onClick(() => this.submit()));
  }

  private submit(): void {
    this.submitted = true;
    this.resolve(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.resolve(null);
  }
}

export function promptPassphrase(app: App, titleText: string): Promise<string | null> {
  return new Promise((resolve) => {
    new PassphrasePromptModal(app, titleText, resolve).open();
  });
}
