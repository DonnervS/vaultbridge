import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultbridgePlugin from "../main";
import { decodeSetup } from "../setup/setupString";
import { runSelfTest } from "../setup/selfTest";
import { promptPassphrase } from "./PassphrasePromptModal";

export class VaultbridgeSettingsTab extends PluginSettingTab {
  plugin: VaultbridgePlugin;

  constructor(app: App, plugin: VaultbridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vaultbridge" });

    new Setting(containerEl)
      .setName("Setup-String")
      .setDesc("Vom Administrator erzeugter String (beginnt mit \"vbridge1:\"). Wie ein Passwort behandeln.")
      .addTextArea((ta) => {
        ta.setPlaceholder("vbridge1:…")
          .setValue(this.plugin.settings.setupString)
          .onChange(async (value) => {
            this.plugin.settings.setupString = value.trim();
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 4;
        ta.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Gerätename")
      .setDesc("Name dieses Geräts im Sync.")
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Selbsttest")
      .setDesc("Prüft Verschlüsselung und CouchDB-Verbindung.")
      .addButton((b) =>
        b.setButtonText("Selbsttest ausführen").setCta().onClick(async () => {
          await this.runSelfTest();
        }),
      );
  }

  private async runSelfTest(): Promise<void> {
    let payload;
    try {
      payload = decodeSetup(this.plugin.settings.setupString);
    } catch (e) {
      new Notice(`Setup-String ungültig: ${(e as Error).message}`);
      return;
    }
    let passphrase = payload.passphrase ?? "";
    if (payload.pp === "separate") {
      passphrase = (await promptPassphrase(this.app, "Passphrase eingeben")) ?? "";
      if (!passphrase) {
        new Notice("Selbsttest abgebrochen: keine Passphrase eingegeben.");
        return;
      }
    }
    new Notice("Selbsttest läuft …");
    const result = await runSelfTest(payload, passphrase);
    const cryptoIcon = result.crypto.ok ? "✅" : "❌";
    const connIcon = result.connection.ok ? "✅" : "❌";
    new Notice(
      `${cryptoIcon} Verschlüsselung: ${result.crypto.message}\n` +
        `${connIcon} Verbindung: ${result.connection.message}`,
      10000,
    );
  }
}
