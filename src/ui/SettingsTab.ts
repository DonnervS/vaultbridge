import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultbridgePlugin from "../main";
import { decodeSetup } from "../setup/setupString";
import { runSelfTest } from "../setup/selfTest";
import { promptPassphrase } from "./PassphrasePromptModal";
import { GeneratorModal } from "./GeneratorModal";
import { RotationModal } from "./RotationModal";
import { DEFAULT_RULES, cloneRules } from "../vault/rules";
import type { SyncMode } from "../store/syncModes";

// Ordner/Dateien, die der "Plugins & Themes synchronisieren"-Schalter steuert.
// Aus = diese Pfade werden ausgeschlossen; An = sie syncen (Standard).
const PLUGIN_SYNC_PATHS = [
  ".obsidian/plugins",
  ".obsidian/themes",
  ".obsidian/snippets",
  ".obsidian/community-plugins.json",
];

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

    // Defensive: Altdaten aus einer Version vor den Regeln könnten `rules`
    // fehlen lassen, obwohl loadSettings() das eigentlich absichert.
    if (!this.plugin.settings.rules) {
      this.plugin.settings.rules = cloneRules(DEFAULT_RULES);
    }

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
      .setName("Setup-String erzeugen")
      .setDesc("Öffnet einen Generator, der aus Zugangsdaten einen \"vbridge1:\"-String samt QR-Code baut.")
      .addButton((b) =>
        b.setButtonText("Setup-String erzeugen").onClick(() => {
          new GeneratorModal(this.app).open();
        }),
      );

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

    new Setting(containerEl)
      .setName("Passphrase ändern")
      .setDesc("Verschlüsselt alle Dateien mit einer neuen Passphrase neu. Erfordert eine aktive Verbindung.")
      .addButton((b) =>
        b.setButtonText("Passphrase ändern").onClick(() => {
          new RotationModal(this.plugin, this.app).open();
        }),
      );

    containerEl.createEl("h3", { text: "Dateisteuerung" });

    containerEl.createEl("p", {
      text:
        "Standardmäßig wird alles synchronisiert — normale Notizen genauso wie " +
        "versteckte Ordner (z. B. .claude, .hinote). Steuere über die Ausschlüsse, " +
        "was NICHT syncen soll.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Versteckte Dateien synchronisieren")
      .setDesc("An = Dotfiles/-ordner (.claude, .hinote, .obsidian …) syncen mit. Aus = nur normale Notizen.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rules.syncHidden).onChange(async (value) => {
          this.plugin.settings.rules.syncHidden = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Ausschließen (ein Eintrag pro Zeile)")
      .setDesc(
        "Ein Dateipfad (Dev/geheim.md) schließt genau die Datei aus. " +
          "Ein Ordner (Dev/projekt/node_modules) schließt ihn samt Unterordnern aus. " +
          "Ein Name ohne Schrägstrich (node_modules) greift ÜBERALL im Vault — nutze einen " +
          "vollständigen Pfad, wenn du nur einen bestimmten Ordner/eine Datei meinst. Globs (*, **) sind auch erlaubt.",
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.rules.exclude.join("\n")).onChange(async (value) => {
          this.plugin.settings.rules.exclude = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 6;
        ta.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Trotzdem synchronisieren (Ausnahmen)")
      .setDesc(
        "Selten gebraucht: Pfade, die trotz eines Ausschlusses gesynct werden sollen " +
          "(z. B. eine einzelne Datei in einem ausgeschlossenen Ordner). Meist leer.",
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.rules.include.join("\n")).onChange(async (value) => {
          this.plugin.settings.rules.include = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Regeln zurücksetzen")
      .addButton((b) =>
        b.setButtonText("Auf Standard zurücksetzen").onClick(async () => {
          this.plugin.settings.rules = cloneRules(DEFAULT_RULES);
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    containerEl.createEl("p", {
      text: "Änderungen an den Regeln wirken beim nächsten Verbinden.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Plugins & Themes synchronisieren")
      .setDesc("An (Standard) verteilt Plugin-Code und -Einstellungen über alle Geräte. Vaultbridge selbst wird nie synchronisiert.")
      .addToggle((t) => {
        const exclude = this.plugin.settings.rules.exclude;
        const enabled = !PLUGIN_SYNC_PATHS.some((p) => exclude.includes(p));
        t.setValue(enabled).onChange(async (value) => {
          if (value) {
            this.plugin.settings.rules.exclude = this.plugin.settings.rules.exclude.filter(
              (p) => !PLUGIN_SYNC_PATHS.includes(p),
            );
          } else {
            for (const p of PLUGIN_SYNC_PATHS) {
              if (!this.plugin.settings.rules.exclude.includes(p)) this.plugin.settings.rules.exclude.push(p);
            }
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    containerEl.createEl("h3", { text: "Synchronisierung" });

    new Setting(containerEl)
      .setName("Sync-Modus")
      .addDropdown((d) =>
        d
          .addOptions({
            continuous: "Kontinuierlich",
            interval: "Intervall",
            onOpenClose: "Bei App-Start und -Ende",
            manual: "Manuell",
          })
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as SyncMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Intervall (Sekunden)")
      .setDesc("Nur relevant im Sync-Modus \"Intervall\".")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async (value) => {
          const parsed = Math.floor(Number(value));
          this.plugin.settings.intervalSeconds = Number.isFinite(parsed) ? Math.max(10, parsed) : 10;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Nur im WLAN synchronisieren")
      .setDesc("Gilt auf Mobilgeräten.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.wifiOnly).onChange(async (value) => {
          this.plugin.settings.wifiOnly = value;
          await this.plugin.saveSettings();
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
