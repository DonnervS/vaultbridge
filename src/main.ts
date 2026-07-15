import { Notice, Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { decodeSetup } from "./setup/setupString";
import { deriveKeys } from "./crypto/crypto";
import { base64urlToBytes } from "./crypto/encoding";
import { PouchDB } from "./store/pouch";
import { VaultStore } from "./store/store";
import { startSync, SyncHandle } from "./store/replication";
import { EchoGuard } from "./vault/applyChange";
import { VaultBridge } from "./vault/bridge";
import { promptPassphrase } from "./ui/PassphrasePromptModal";
import { ConflictListView, VIEW_TYPE_CONFLICTS } from "./ui/ConflictListView";

export interface VaultbridgeSettings {
  setupString: string;
  deviceName: string;
}

const DEFAULT_SETTINGS: VaultbridgeSettings = { setupString: "", deviceName: "" };

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = { ...DEFAULT_SETTINGS };
  private statusBar!: StatusBar;
  private syncHandle: SyncHandle | null = null;
  private bridge: VaultBridge | null = null;
  private localDb: PouchDB.Database | null = null;
  private store: VaultStore | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new VaultbridgeSettingsTab(this.app, this));
    this.addCommand({ id: "vaultbridge-connect", name: "Vaultbridge: Verbinden", callback: () => this.connect() });
    this.addCommand({ id: "vaultbridge-disconnect", name: "Vaultbridge: Trennen", callback: () => this.disconnect() });
    // Kein Auto-Connect: der Nutzer startet den Sync über den Befehl
    // "Vaultbridge: Verbinden" (nötig, weil eine Passphrase abgefragt werden kann).

    this.registerView(
      VIEW_TYPE_CONFLICTS,
      (leaf) => new ConflictListView(leaf, () => this.store),
    );
    this.addCommand({
      id: "vaultbridge-show-conflicts",
      name: "Vaultbridge: Konflikte anzeigen",
      callback: () => this.openConflictView(),
    });
  }

  async onunload(): Promise<void> {
    this.disconnect();
  }

  async connect(): Promise<void> {
    this.disconnect(); // vorherige Verbindung sauber beenden (re-entrant-sicher)
    try {
      const payload = decodeSetup(this.settings.setupString);
      let passphrase = payload.passphrase ?? "";
      if (payload.pp === "separate") {
        passphrase = (await promptPassphrase(this.app, "Passphrase eingeben")) ?? "";
        if (!passphrase) { new Notice("Vaultbridge: keine Passphrase, abgebrochen."); return; }
      }
      const keys = await deriveKeys(passphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
      this.localDb = new PouchDB(`vaultbridge-${payload.db}`);
      const store = new VaultStore(this.localDb, keys, payload.opts.chunkSize);
      this.store = store;
      const guard = new EchoGuard();
      this.bridge = new VaultBridge(this.app, store, guard);
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, { auth: { username: payload.user, password: payload.pass } });
      this.syncHandle = startSync(this.localDb, remote, { live: true }, (s, info) => this.statusBar.setStatus(s, info));
      new Notice("Vaultbridge verbunden.");
    } catch (e) {
      this.disconnect();
      this.statusBar.setStatus("error", String(e));
      new Notice(`Vaultbridge: Verbindung fehlgeschlagen: ${String(e)}`);
    }
  }

  disconnect(): void {
    this.syncHandle?.stop();
    this.syncHandle = null;
    this.bridge?.stop();
    this.bridge = null;
    void this.localDb?.close();
    this.localDb = null;
    this.store = null;
    this.statusBar?.setInactive();
  }

  async openConflictView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
