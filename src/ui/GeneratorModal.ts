import { App, Modal, Notice, Setting } from "obsidian";
import QRCode from "qrcode";
import { encodeSetup, SetupPayload } from "../setup/setupString";
import { bytesToBase64url } from "../crypto/encoding";

const KDF_ITERATIONS = 210000;
const CHUNK_SIZE = 100000;

/**
 * Erzeugt einen "vbridge1:"-Setup-String (inkl. QR-Code) aus Formularfeldern,
 * damit ein Zweitgerät ohne manuelles Zusammensetzen des Strings verbunden
 * werden kann. Der String enthält Zugangsdaten (und ggf. die Passphrase) und
 * ist entsprechend wie ein Passwort zu behandeln.
 */
export class GeneratorModal extends Modal {
  private couchUrl = "";
  private db = "";
  private user = "";
  private pass = "";
  private passphrase = "";
  private obfuscatePaths = true;
  private gzip = true;

  private outputEl!: HTMLElement;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Vaultbridge: Setup-String erzeugen" });

    const warning = contentEl.createEl("p", {
      text:
        "Achtung: Dieser String enthält Zugangsdaten (und ggf. die Passphrase). " +
        "Wie ein Passwort behandeln.",
      cls: "mod-warning",
    });
    warning.style.fontWeight = "bold";

    new Setting(contentEl)
      .setName("CouchDB-URL")
      .addText((t) =>
        t.setPlaceholder("https://couch.example.com").onChange((v) => (this.couchUrl = v.trim())),
      );

    new Setting(contentEl)
      .setName("Datenbankname")
      .addText((t) => t.setPlaceholder("mein-vault").onChange((v) => (this.db = v.trim())));

    new Setting(contentEl)
      .setName("Benutzer")
      .addText((t) => t.onChange((v) => (this.user = v.trim())));

    new Setting(contentEl).setName("Passwort").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.pass = v));
    });

    new Setting(contentEl)
      .setName("Passphrase")
      .setDesc(
        "Leer lassen = Modus \"getrennt\" (Passphrase wird bei jedem Verbinden separat abgefragt, " +
          "nicht im String gespeichert). Ausfüllen = Modus \"eingebettet\".",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (this.passphrase = v));
      });

    new Setting(contentEl)
      .setName("Pfad-Verschleierung")
      .setDesc("Dateipfade vor dem Upload verschleiern.")
      .addToggle((tg) => tg.setValue(this.obfuscatePaths).onChange((v) => (this.obfuscatePaths = v)));

    new Setting(contentEl)
      .setName("gzip")
      .setDesc("Inhalte vor der Verschlüsselung komprimieren.")
      .addToggle((tg) => tg.setValue(this.gzip).onChange((v) => (this.gzip = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Erzeugen")
        .setCta()
        .onClick(() => void this.generate()),
    );

    this.outputEl = contentEl.createDiv();
  }

  private async generate(): Promise<void> {
    if (!this.couchUrl || !this.db || !this.user || !this.pass) {
      new Notice("Bitte alle Pflichtfelder ausfüllen.");
      return;
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const embedded = this.passphrase.trim().length > 0;
    const payload: SetupPayload = {
      v: 1,
      couchUrl: this.couchUrl,
      db: this.db,
      user: this.user,
      pass: this.pass,
      kdfSalt: bytesToBase64url(salt),
      kdfIter: KDF_ITERATIONS,
      pp: embedded ? "embedded" : "separate",
      ...(embedded ? { passphrase: this.passphrase } : {}),
      opts: { obfuscatePaths: this.obfuscatePaths, chunkSize: CHUNK_SIZE, gzip: this.gzip },
    };
    const str = encodeSetup(payload);

    await this.renderOutput(str);
  }

  private async renderOutput(str: string): Promise<void> {
    const out = this.outputEl;
    out.empty();

    out.createEl("h4", { text: "Setup-String" });

    const ta = out.createEl("textarea");
    ta.readOnly = true;
    ta.value = str;
    ta.rows = 6;
    ta.style.width = "100%";
    ta.addEventListener("focus", () => ta.select());

    new Setting(out).addButton((b) =>
      b.setButtonText("In Zwischenablage kopieren").onClick(async () => {
        try {
          await navigator.clipboard.writeText(str);
          new Notice("Setup-String kopiert.");
        } catch {
          ta.focus();
          ta.select();
          const ok = document.execCommand("copy");
          new Notice(ok ? "Setup-String kopiert." : "Kopieren fehlgeschlagen. Bitte manuell markieren.");
        }
      }),
    );

    out.createEl("h4", { text: "QR-Code" });
    try {
      const dataUrl = await QRCode.toDataURL(str, { margin: 1, width: 256 });
      const img = out.createEl("img");
      img.src = dataUrl;
      img.style.display = "block";
    } catch (e) {
      out.createEl("p", { text: `QR-Code konnte nicht erzeugt werden: ${String(e)}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
