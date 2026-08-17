import { App, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type VaultbridgePlugin from "../main";
import { decodeSetup } from "../setup/setupString";
import { runSelfTest } from "../setup/selfTest";
import { makeRequestUrlFetch } from "../store/obsidianFetch";
import { promptPassphrase } from "./PassphrasePromptModal";
import { GeneratorModal } from "./GeneratorModal";
import { RotationModal } from "./RotationModal";
import { DEFAULT_RULES, cloneRules } from "../vault/rules";
import type { SyncMode } from "../store/syncModes";

// Ordner/Dateien, die der "Plugins & Themes synchronisieren"-Schalter steuert.
// Aus = diese Pfade werden ausgeschlossen; An = sie syncen (Standard). Aus dem
// echten configDir gebildet (der Nutzer kann Obsidians Konfigordner umbenennen).
function pluginSyncPathsFor(configDir: string): string[] {
  return [
    `${configDir}/plugins`,
    `${configDir}/themes`,
    `${configDir}/snippets`,
    `${configDir}/community-plugins.json`,
  ];
}

export class VaultbridgeSettingsTab extends PluginSettingTab {
  plugin: VaultbridgePlugin;

  constructor(app: App, plugin: VaultbridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Kein eigener "Vaultbridge"-Überschriftenblock: Obsidian zeigt den
    // Plugin-Namen bereits als Titel des Einstellungs-Tabs (Review-Regel
    // no-problematic-settings-headings).

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
        ta.inputEl.addClass("vaultbridge-full-width");
      });

    new Setting(containerEl)
      .setName("Setup-String erzeugen")
      .setDesc("Öffnet einen Generator, der aus Zugangsdaten einen \"vbridge1:\"-String samt QR-Code baut. Mit \"Für dieses Gerät übernehmen\" wird er direkt hier eingetragen — kein Kopieren nötig.")
      .addButton((b) =>
        b.setButtonText("Setup-String erzeugen").onClick(() => {
          new GeneratorModal(this.app, async (setupString) => {
            this.plugin.settings.setupString = setupString;
            await this.plugin.saveSettings();
            this.display(); // Setup-String-Feld mit dem übernommenen Wert aktualisieren
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName("Gerätename")
      .setDesc(
        "Wird bei jeder Änderung mitgespeichert (verschlüsselt) und in der Konfliktansicht angezeigt, " +
          "damit du siehst, auf welchem Gerät eine Abweichung entstanden ist. Beim ersten Verbinden " +
          "automatisch vorbelegt.",
      )
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

    new Setting(containerEl).setName("Dateisteuerung").setHeading();

    containerEl.createEl("p", {
      text:
        "Standardmäßig wird alles synchronisiert — normale Notizen genauso wie " +
        "versteckte Ordner (z. B. .claude, .hinote). Steuere über die Ausschlüsse, " +
        "was NICHT syncen soll.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Versteckte Dateien synchronisieren")
      .setDesc("An = Dotfiles/-ordner (.claude, .hinote, Obsidian-Konfigordner …) syncen mit. Aus = nur normale Notizen.")
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
        ta.inputEl.addClass("vaultbridge-full-width");
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
        ta.inputEl.addClass("vaultbridge-full-width");
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
        const pluginSyncPaths = pluginSyncPathsFor(this.plugin.app.vault.configDir);
        const exclude = this.plugin.settings.rules.exclude;
        const enabled = !pluginSyncPaths.some((p) => exclude.includes(p));
        t.setValue(enabled).onChange(async (value) => {
          if (value) {
            this.plugin.settings.rules.exclude = this.plugin.settings.rules.exclude.filter(
              (p) => !pluginSyncPaths.includes(p),
            );
          } else {
            for (const p of pluginSyncPaths) {
              if (!this.plugin.settings.rules.exclude.includes(p)) this.plugin.settings.rules.exclude.push(p);
            }
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl).setName("Synchronisierung").setHeading();

    new Setting(containerEl)
      .setName("Automatisch verbinden")
      .setDesc("Beim Start von Obsidian automatisch verbinden. Aus = nur über den Befehl \"Vaultbridge: Verbinden\".")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autostart).onChange(async (value) => {
          this.plugin.settings.autostart = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Verbindungsart")
      .setDesc(
        "Wie Vaultbridge die CouchDB anspricht. „Browser\" ist der Standard und überträgt laufend " +
          "(Streaming). „Obsidian (requestUrl)\" leitet über Obsidians eigene HTTP-Schicht um.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ fetch: "Browser (Standard)", requestUrl: "Obsidian (requestUrl)" })
          .setValue(this.plugin.settings.transport)
          .onChange(async (value) => {
            this.plugin.settings.transport = value as "fetch" | "requestUrl";
            await this.plugin.saveSettings();
            new Notice("Vaultbridge: wirkt beim nächsten Verbinden.");
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Verbindung wird blockiert? Chrome 142 — die Grundlage aktueller Obsidian-Versionen — verlangt eine " +
        "Berechtigung, bevor eine App auf Adressen im lokalen Netz zugreifen darf (192.168.…, 10.…, localhost). " +
        "Obsidian hat für diese Abfrage keine Oberfläche, deshalb schlägt die Verbindung ohne Erklärung fehl. " +
        "Am Server lässt sich das nicht beheben: der früher übliche Header Access-Control-Allow-Private-Network " +
        "wird von Chrome 142 nicht mehr ausgewertet. Stell in diesem Fall die Verbindungsart auf " +
        "„Obsidian (requestUrl)\" — damit läuft der Sync an dieser Sperre vorbei. Der Selbsttest prüft beide Wege.",
    });

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
    const result = await runSelfTest(
      payload,
      passphrase,
      fetch,
      makeRequestUrlFetch(requestUrl),
    );
    const icon = (ok: boolean): string => (ok ? "✅" : "❌");
    const lines = [
      `${icon(result.crypto.ok)} Verschlüsselung: ${result.crypto.message}`,
      `${icon(result.connection.ok)} Browser: ${result.connection.message}`,
    ];
    if (result.connectionRequestUrl) {
      lines.push(`${icon(result.connectionRequestUrl.ok)} Obsidian (requestUrl): ${result.connectionRequestUrl.message}`);
      if (!result.connection.ok && result.connectionRequestUrl.ok) {
        lines.push("→ Stell die Verbindungsart auf „Obsidian (requestUrl)\" um.");
      }
    }
    new Notice(lines.join("\n"), 15000);
  }
}
