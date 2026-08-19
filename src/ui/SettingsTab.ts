import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  requestUrl,
  requireApiVersion,
} from "obsidian";
import type {
  SettingControl,
  SettingDefinition,
  SettingDefinitionAction,
  SettingDefinitionItem,
  SettingDefinitionRender,
} from "obsidian";
import type VaultbridgePlugin from "../main";
import { decodeSetup } from "../setup/setupString";
import { runSelfTest } from "../setup/selfTest";
import { browserFetch } from "../setup/browserFetch";
import { makeRequestUrlFetch } from "../store/obsidianFetch";
import { promptPassphrase } from "./PassphrasePromptModal";
import { GeneratorModal } from "./GeneratorModal";
import { RotationModal } from "./RotationModal";
import { DEFAULT_RULES, cloneRules } from "../vault/rules";
import type { SyncRules } from "../vault/rules";
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

/**
 * Aktionszeile (Schaltfläche). Die deklarative API kennt für `action`-Einträge
 * kein Feld für eine Schaltflächen-Beschriftung — dort wird die Zeile selbst
 * klickbar. Der Alt-Pfad (display(), Obsidian < 1.13) rendert dagegen wie bisher
 * einen Button; `buttonText` liefert dessen Beschriftung, `cta` markiert die
 * hervorgehobene Schaltfläche. Beide Felder sind Zusatzangaben, die Obsidian
 * ignoriert — die Definition bleibt die einzige Quelle der Wahrheit.
 */
interface AktionsDefinition extends SettingDefinitionAction {
  buttonText: string;
  cta?: boolean;
}

/**
 * Reiner Erklärabsatz ohne eigene Einstellung. Auf dem Alt-Pfad wird daraus
 * exakt wie bisher ein <p class="setting-item-description">; ab 1.13 rendert der
 * Host den Text über `render` als Beschreibungszeile. `hinweis` trägt denselben
 * Text für den Alt-Pfad, damit beide Wege aus derselben Definition entstehen.
 */
interface HinweisDefinition extends SettingDefinitionRender {
  hinweis: string;
}

function hinweis(text: string): HinweisDefinition {
  return {
    name: "",
    searchable: false,
    hinweis: text,
    render: (setting: Setting) => {
      setting.setDesc(text);
    },
  };
}

/** Identität — nur damit die Zusatzfelder typgeprüft übernommen werden. */
function aktion(def: AktionsDefinition): AktionsDefinition {
  return def;
}

/** `visible`/`disabled` dürfen laut API auch Funktionen sein. */
function istWahr(flag: boolean | (() => boolean) | undefined, standard: boolean): boolean {
  if (flag === undefined) return standard;
  return typeof flag === "function" ? flag() : flag;
}

/** Wert aus getControlValue() (Typ `unknown`) als Text für ein Eingabefeld. */
function alsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Wert aus getControlValue() (Typ `unknown`) als Zahl. */
function alsZahl(value: unknown, standard: number): number {
  const zahl = typeof value === "number" ? value : Number(alsText(value));
  return Number.isFinite(zahl) ? zahl : standard;
}

/** Mehrzeiliges Textfeld -> Liste: trimmen, Leerzeilen verwerfen. */
function zeilen(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class VaultbridgeSettingsTab extends PluginSettingTab {
  plugin: VaultbridgePlugin;

  constructor(app: App, plugin: VaultbridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ---------------------------------------------------------------------------
  // Deklarative Beschreibung — die einzige Quelle der Wahrheit. Ab Obsidian 1.13
  // rendert und durchsucht der Host die Einstellungen direkt hieraus; darunter
  // interpretiert display() dieselbe Beschreibung (siehe zeichneAlles()).
  // ---------------------------------------------------------------------------
  getSettingDefinitions(): SettingDefinitionItem[] {
    this.regeln(); // defensive Absicherung von settings.rules vor dem Rendern

    return [
      {
        name: "Setup-String",
        desc: "Vom Administrator erzeugter String (beginnt mit \"vbridge1:\"). Wie ein Passwort behandeln.",
        control: { type: "textarea", key: "setupString", placeholder: "vbridge1:…", rows: 4 },
      },
      aktion({
        name: "Setup-String erzeugen",
        desc: "Öffnet einen Generator, der aus Zugangsdaten einen \"vbridge1:\"-String samt QR-Code baut. Mit \"Für dieses Gerät übernehmen\" wird er direkt hier eingetragen — kein Kopieren nötig.",
        buttonText: "Setup-String erzeugen",
        action: () => {
          new GeneratorModal(this.app, async (setupString) => {
            await this.setControlValue("setupString", setupString);
            this.neuZeichnen(); // Setup-String-Feld mit dem übernommenen Wert aktualisieren
          }).open();
        },
      }),
      {
        name: "Gerätename",
        desc:
          "Wird bei jeder Änderung mitgespeichert (verschlüsselt) und in der Konfliktansicht angezeigt, " +
          "damit du siehst, auf welchem Gerät eine Abweichung entstanden ist. Beim ersten Verbinden " +
          "automatisch vorbelegt.",
        control: { type: "text", key: "deviceName" },
      },
      aktion({
        name: "Selbsttest",
        desc: "Prüft Verschlüsselung und CouchDB-Verbindung.",
        buttonText: "Selbsttest ausführen",
        cta: true,
        action: () => {
          void this.runSelfTest();
        },
      }),
      aktion({
        name: "Passphrase ändern",
        desc: "Verschlüsselt alle Dateien mit einer neuen Passphrase neu. Erfordert eine aktive Verbindung.",
        buttonText: "Passphrase ändern",
        action: () => {
          new RotationModal(this.plugin, this.app).open();
        },
      }),
      {
        type: "group",
        heading: "Dateisteuerung",
        items: [
          hinweis(
            "Standardmäßig wird alles synchronisiert — normale Notizen genauso wie " +
              "versteckte Ordner (z. B. .claude, .hinote). Steuere über die Ausschlüsse, " +
              "was NICHT syncen soll.",
          ),
          {
            name: "Versteckte Dateien synchronisieren",
            desc: "An = Dotfiles/-ordner (.claude, .hinote, Obsidian-Konfigordner …) syncen mit. Aus = nur normale Notizen.",
            control: { type: "toggle", key: "rules.syncHidden" },
          },
          {
            name: "Ausschließen (ein Eintrag pro Zeile)",
            desc:
              "Ein Dateipfad (Dev/geheim.md) schließt genau die Datei aus. " +
              "Ein Ordner (Dev/projekt/node_modules) schließt ihn samt Unterordnern aus. " +
              "Ein Name ohne Schrägstrich (node_modules) greift ÜBERALL im Vault — nutze einen " +
              "vollständigen Pfad, wenn du nur einen bestimmten Ordner/eine Datei meinst. Globs (*, **) sind auch erlaubt.",
            control: { type: "textarea", key: "rules.exclude", rows: 6 },
          },
          {
            name: "Trotzdem synchronisieren (Ausnahmen)",
            desc:
              "Selten gebraucht: Pfade, die trotz eines Ausschlusses gesynct werden sollen " +
              "(z. B. eine einzelne Datei in einem ausgeschlossenen Ordner). Meist leer.",
            control: { type: "textarea", key: "rules.include", rows: 3 },
          },
          aktion({
            name: "Regeln zurücksetzen",
            buttonText: "Auf Standard zurücksetzen",
            action: () => {
              void this.regelnZuruecksetzen();
            },
          }),
          hinweis("Änderungen an den Regeln wirken beim nächsten Verbinden."),
          {
            name: "Plugins & Themes synchronisieren",
            desc: "An (Standard) verteilt Plugin-Code und -Einstellungen über alle Geräte. Vaultbridge selbst wird nie synchronisiert.",
            control: { type: "toggle", key: "pluginSync" },
          },
        ],
      },
      {
        type: "group",
        heading: "Synchronisierung",
        items: [
          {
            name: "Automatisch verbinden",
            desc: "Beim Start von Obsidian automatisch verbinden. Aus = nur über den Befehl \"Vaultbridge: Verbinden\".",
            control: { type: "toggle", key: "autostart" },
          },
          {
            name: "Verbindungsart",
            desc:
              "Wie Vaultbridge die CouchDB anspricht. „Browser\" ist der Standard und überträgt laufend " +
              "(Streaming). „Obsidian (requestUrl)\" leitet über Obsidians eigene HTTP-Schicht um.",
            control: {
              type: "dropdown",
              key: "transport",
              options: { fetch: "Browser (Standard)", requestUrl: "Obsidian (requestUrl)" },
            },
          },
          hinweis(
            "Verbindung wird blockiert? Chrome 142 — die Grundlage aktueller Obsidian-Versionen — verlangt eine " +
              "Berechtigung, bevor eine App auf Adressen im lokalen Netz zugreifen darf (192.168.…, 10.…, localhost). " +
              "Obsidian hat für diese Abfrage keine Oberfläche, deshalb schlägt die Verbindung ohne Erklärung fehl. " +
              "Am Server lässt sich das nicht beheben: der früher übliche Header Access-Control-Allow-Private-Network " +
              "wird von Chrome 142 nicht mehr ausgewertet. Stell in diesem Fall die Verbindungsart auf " +
              "„Obsidian (requestUrl)\" — damit läuft der Sync an dieser Sperre vorbei. Der Selbsttest prüft beide Wege.",
          ),
          {
            name: "Sync-Modus",
            control: {
              type: "dropdown",
              key: "syncMode",
              options: {
                continuous: "Kontinuierlich",
                interval: "Intervall",
                onOpenClose: "Bei App-Start und -Ende",
                manual: "Manuell",
              },
            },
          },
          {
            name: "Intervall (Sekunden)",
            desc: "Nur relevant im Sync-Modus \"Intervall\".",
            control: { type: "number", key: "intervalSeconds", min: 10, step: 1 },
          },
          {
            name: "Nur im WLAN synchronisieren",
            desc: "Gilt auf Mobilgeräten.",
            control: { type: "toggle", key: "wifiOnly" },
          },
        ],
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Lesen/Schreiben der Werte. Beide Renderwege gehen ausschließlich hierüber,
  // damit ein Wert nie an zwei Stellen unterschiedlich behandelt wird.
  // ---------------------------------------------------------------------------
  getControlValue(key: string): unknown {
    switch (key) {
      case "rules.syncHidden":
        return this.regeln().syncHidden;
      // Als Liste gespeichert, als Text bearbeitet.
      case "rules.exclude":
        return this.regeln().exclude.join("\n");
      case "rules.include":
        return this.regeln().include.join("\n");
      // Abgeleitet: an, solange keiner der Plugin-Sync-Pfade ausgeschlossen ist.
      case "pluginSync": {
        const pfade = pluginSyncPathsFor(this.plugin.app.vault.configDir);
        const exclude = this.regeln().exclude;
        return !pfade.some((p) => exclude.includes(p));
      }
      default:
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "setupString":
        settings.setupString = String(value).trim();
        break;
      case "deviceName":
        settings.deviceName = String(value);
        break;
      case "autostart":
        settings.autostart = Boolean(value);
        break;
      case "wifiOnly":
        settings.wifiOnly = Boolean(value);
        break;
      case "syncMode":
        settings.syncMode = String(value) as SyncMode;
        break;
      case "transport":
        settings.transport = String(value) as "fetch" | "requestUrl";
        break;
      case "intervalSeconds": {
        // Untergrenze weiterhin hier erzwingen: Das number-Steuerelement meldet
        // `min` nur an die Oberfläche. Werte aus anderen Quellen (Altdaten,
        // getippte Zwischenstände) müssen ebenso gekappt werden.
        const parsed = Math.floor(Number(value));
        settings.intervalSeconds = Number.isFinite(parsed) ? Math.max(10, parsed) : 10;
        break;
      }
      case "rules.syncHidden":
        this.regeln().syncHidden = Boolean(value);
        break;
      case "rules.exclude":
        this.regeln().exclude = zeilen(String(value));
        break;
      case "rules.include":
        this.regeln().include = zeilen(String(value));
        break;
      case "pluginSync":
        this.setzePluginSync(Boolean(value));
        break;
      default:
        return; // unbekannter Schlüssel: nichts schreiben
    }
    await this.plugin.saveSettings();
    if (key === "transport") {
      new Notice("Vaultbridge: wirkt beim nächsten Verbinden.");
    }
    if (key === "pluginSync") {
      // Der Schalter schreibt in die Ausschlussliste — das Textfeld darüber
      // zeigt sonst einen veralteten Stand.
      this.neuZeichnen();
    }
  }

  // ---------------------------------------------------------------------------
  // Alt-Pfad: Interpreter über dieselben Definitionen.
  // ---------------------------------------------------------------------------
  display(): void {
    // Ab Obsidian 1.13 zeichnet der Host die Oberfläche selbst aus
    // getSettingDefinitions(). Laut Typings ruft er display() dann gar nicht
    // mehr auf — zugesichert ist das aber nicht, deshalb hier der Riegel: es
    // soll immer nur genau ein Renderer laufen.
    if (requireApiVersion("1.13.0")) return;
    this.zeichneAlles();
  }

  /** Zeichnet den gesamten Tab aus den Definitionen (nur Obsidian < 1.13). */
  private zeichneAlles(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Kein eigener "Vaultbridge"-Überschriftenblock: Obsidian zeigt den
    // Plugin-Namen bereits als Titel des Einstellungs-Tabs (Review-Regel
    // no-problematic-settings-headings).
    this.zeichneItems(containerEl, this.getSettingDefinitions());
  }

  /** Neu zeichnen, nachdem sich Werte außerhalb eines Steuerelements geändert haben. */
  private neuZeichnen(): void {
    if (requireApiVersion("1.13.0")) {
      // update() liest die Definitionen neu ein und aktualisiert die vom Host
      // gezeichnete Oberfläche. Gibt es erst ab 1.13, daher hinter der Abfrage.
      this.update();
      return;
    }
    this.zeichneAlles();
  }

  private zeichneItems(containerEl: HTMLElement, items: SettingDefinitionItem[]): void {
    for (const item of items) {
      if ("type" in item) {
        // Eigene Unterseiten nutzt Vaultbridge nicht; Gruppen/Listen werden als
        // Überschrift plus flach darunter liegende Zeilen gezeichnet.
        if (item.type === "page") continue;
        if (!istWahr(item.visible, true)) continue;
        if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
        this.zeichneItems(containerEl, item.items ?? []);
        continue;
      }
      if (!istWahr(item.visible, true)) continue;
      this.zeichneDefinition(containerEl, item);
    }
  }

  private zeichneDefinition(containerEl: HTMLElement, def: SettingDefinition): void {
    // Reiner Erklärabsatz: wie bisher als eigenständiges <p>, nicht als Zeile.
    const hinweisText = (def as Partial<HinweisDefinition>).hinweis;
    if (hinweisText !== undefined) {
      containerEl.createEl("p", { text: hinweisText, cls: "setting-item-description" });
      return;
    }

    const setting = new Setting(containerEl);
    if (def.name) setting.setName(def.name);
    if (def.desc !== undefined) setting.setDesc(def.desc);

    if (def.control) {
      this.zeichneControl(setting, def.control);
      return;
    }
    if (def.action) {
      const extra = def as Partial<AktionsDefinition>;
      const aufruf = def.action;
      setting.addButton((b) => {
        b.setButtonText(extra.buttonText ?? def.name);
        if (extra.cta) b.setCta();
        if (istWahr(extra.disabled, false)) b.setDisabled(true);
        b.onClick(() => aufruf(setting.settingEl, 0));
      });
      return;
    }
    if (def.render) {
      // Unsere render-Rückrufe nutzen das zweite Argument (SettingGroup) nicht.
      // SettingGroup gibt es zudem erst ab Obsidian 1.11 und darf auf diesem
      // Pfad (minAppVersion 1.7.2) nicht instanziiert werden.
      (def.render as (setting: Setting) => void)(setting);
    }
  }

  private zeichneControl(setting: Setting, control: SettingControl): void {
    const key = control.key;
    const wert = (): unknown => this.getControlValue(key) ?? control.defaultValue;
    const gesperrt = istWahr(control.disabled, false);

    switch (control.type) {
      case "toggle":
        setting.addToggle((t) => {
          t.setValue(Boolean(wert())).onChange(async (v) => {
            await this.setControlValue(key, v);
          });
          t.setDisabled(gesperrt);
        });
        break;
      case "textarea":
        setting.addTextArea((ta) => {
          if (control.placeholder) ta.setPlaceholder(control.placeholder);
          ta.setValue(alsText(wert())).onChange(async (v) => {
            await this.setControlValue(key, v);
          });
          if (control.rows) ta.inputEl.rows = control.rows;
          ta.inputEl.addClass("vaultbridge-full-width");
          ta.setDisabled(gesperrt);
        });
        break;
      case "dropdown":
        setting.addDropdown((d) => {
          d.addOptions(control.options)
            .setValue(alsText(wert()))
            .onChange(async (v) => {
              await this.setControlValue(key, v);
            });
          d.setDisabled(gesperrt);
        });
        break;
      case "number":
        setting.addText((t) => {
          t.inputEl.type = "number";
          if (control.min !== undefined) t.inputEl.min = String(control.min);
          if (control.max !== undefined) t.inputEl.max = String(control.max);
          if (control.step !== undefined) t.inputEl.step = String(control.step);
          if (control.placeholder) t.setPlaceholder(control.placeholder);
          t.setValue(alsText(wert())).onChange(async (v) => {
            await this.setControlValue(key, Number(v));
          });
          t.setDisabled(gesperrt);
        });
        break;
      case "slider":
        setting.addSlider((s) => {
          s.setLimits(control.min, control.max, control.step)
            .setValue(alsZahl(wert(), control.min))
            .onChange(async (v) => {
              await this.setControlValue(key, v);
            });
          s.setDisabled(gesperrt);
        });
        break;
      default: {
        // text sowie file/folder/color: einzeiliges Textfeld. Die Suggester der
        // Datei-/Ordner-Steuerelemente gibt es vor 1.13 nicht; Vaultbridge nutzt
        // sie derzeit ohnehin nicht.
        const platzhalter = (control as { placeholder?: string }).placeholder;
        setting.addText((t) => {
          if (platzhalter) t.setPlaceholder(platzhalter);
          t.setValue(alsText(wert())).onChange(async (v) => {
            await this.setControlValue(key, v);
          });
          t.setDisabled(gesperrt);
        });
      }
    }
  }

  /**
   * Defensive: Altdaten aus einer Version vor den Regeln könnten `rules` fehlen
   * lassen, obwohl loadSettings() das eigentlich absichert.
   */
  private regeln(): SyncRules {
    if (!this.plugin.settings.rules) {
      this.plugin.settings.rules = cloneRules(DEFAULT_RULES);
    }
    return this.plugin.settings.rules;
  }

  /** "Plugins & Themes synchronisieren": setzt/entfernt die zugehörigen Ausschlüsse. */
  private setzePluginSync(aktiv: boolean): void {
    const pfade = pluginSyncPathsFor(this.plugin.app.vault.configDir);
    const regeln = this.regeln();
    if (aktiv) {
      regeln.exclude = regeln.exclude.filter((p) => !pfade.includes(p));
    } else {
      for (const p of pfade) {
        if (!regeln.exclude.includes(p)) regeln.exclude.push(p);
      }
    }
  }

  private async regelnZuruecksetzen(): Promise<void> {
    this.plugin.settings.rules = cloneRules(DEFAULT_RULES);
    await this.plugin.saveSettings();
    // Schalter, beide Textfelder und der abgeleitete Plugin-Sync-Schalter zeigen
    // danach andere Werte — deshalb komplett neu zeichnen.
    this.neuZeichnen();
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
      // Bewusst der Browser-Weg: er übt genau den HTTP-Pfad aus, den PouchDB im
      // Normalbetrieb nimmt — inklusive CORS-Preflight (Begründung ausführlich
      // in browserFetch.ts). Der requestUrl-Weg wird zusätzlich geprüft.
      browserFetch,
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
