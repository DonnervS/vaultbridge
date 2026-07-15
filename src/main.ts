import { Notice, Platform, Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { decodeSetup } from "./setup/setupString";
import { deriveKeys } from "./crypto/crypto";
import { base64urlToBytes } from "./crypto/encoding";
import { PouchDB } from "./store/pouch";
import { VaultStore } from "./store/store";
import { startSync, SyncHandle, SyncStatus } from "./store/replication";
import { EchoGuard } from "./vault/applyChange";
import { VaultBridge } from "./vault/bridge";
import { DEFAULT_RULES, SyncRules } from "./vault/rules";
import { promptPassphrase } from "./ui/PassphrasePromptModal";
import { ConflictListView, VIEW_TYPE_CONFLICTS } from "./ui/ConflictListView";
import { SyncMode, shouldReplicateNow } from "./store/syncModes";
import { planPluginReload } from "./plugins/pluginSync";
import { GeneratorModal } from "./ui/GeneratorModal";

export interface VaultbridgeSettings {
  setupString: string;
  deviceName: string;
  rules: SyncRules;
  // Zuletzt bekannter Stand versteckter Dateien (Pfad -> Hash) für den
  // Drei-Wege-Abgleich in reconcileHidden(). Lebt in den Plugin-eigenen
  // Daten (data.json), NICHT im synchronisierten Vault-Bereich.
  known: Record<string, string>;
  // Sync-Modus + Mobile-Heuristik (M4 Task 6).
  syncMode: SyncMode;
  wifiOnly: boolean;
  intervalSeconds: number;
}

const DEFAULT_SETTINGS: VaultbridgeSettings = {
  setupString: "",
  deviceName: "",
  rules: { ...DEFAULT_RULES, include: [...DEFAULT_RULES.include], exclude: [...DEFAULT_RULES.exclude] },
  known: {},
  syncMode: "continuous",
  wifiOnly: false,
  intervalSeconds: 120,
};

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = { ...DEFAULT_SETTINGS };
  private statusBar!: StatusBar;
  private syncHandle: SyncHandle | null = null;
  private bridge: VaultBridge | null = null;
  private localDb: PouchDB.Database | null = null;
  private remote: PouchDB.Database | null = null;
  private store: VaultStore | null = null;
  private pluginChanges = new Set<string>();
  private pluginReloadTimer: number | null = null;
  private connectIntervals: number[] = [];

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
    this.addCommand({
      id: "vaultbridge-sync-now",
      name: "Vaultbridge: Jetzt synchronisieren",
      callback: () => void this.syncOnce(),
    });
    this.addCommand({
      id: "vaultbridge-generate-setup",
      name: "Vaultbridge: Setup-String erzeugen",
      callback: () => new GeneratorModal(this.app).open(),
    });

    // Regelmäßiger Abgleich versteckter Dateien (Dotfiles/.claude/Plugins):
    // diese lösen keine indizierten Vault-Events aus, daher periodisches Polling.
    this.registerInterval(window.setInterval(() => void this.bridge?.reconcileHidden(), 30000));
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
      this.bridge = new VaultBridge(
        this.app,
        store,
        guard,
        this.settings.rules ?? DEFAULT_RULES,
        () => new Map(Object.entries(this.settings.known ?? {})),
        (m) => { this.settings.known = Object.fromEntries(m); void this.saveSettings(); },
        (p) => this.onHiddenApplied(p),
      );
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, { auth: { username: payload.user, password: payload.pass } });
      this.remote = remote;

      const mode = this.settings.syncMode;
      const onStatus = (s: SyncStatus, info?: string): void => {
        this.statusBar.setStatus(s, info);
        if (s === "idle" || s === "paused") {
          void this.refreshConflicts();
          void this.bridge?.reconcileHidden();
        }
      };
      if (mode === "continuous" && shouldReplicateNow(mode, this.currentCtx())) {
        this.syncHandle = startSync(this.localDb, remote, { live: true }, onStatus);
      } else if (mode === "interval") {
        const id = this.registerInterval(
          window.setInterval(() => {
            if (shouldReplicateNow(mode, this.currentCtx())) void this.syncOnce();
          }, this.settings.intervalSeconds * 1000),
        );
        this.connectIntervals.push(id);
      } else if (mode === "onOpenClose") {
        if (shouldReplicateNow(mode, this.currentCtx())) void this.syncOnce();
        this.registerEvent(
          this.app.workspace.on("quit", (tasks) => {
            if (shouldReplicateNow(mode, this.currentCtx())) tasks.addPromise(this.syncOnce());
          }),
        );
      }
      // manual: nur der "Sync jetzt"-Befehl

      new Notice("Vaultbridge verbunden.");
      void this.refreshConflicts();
      void this.bridge.reconcileHidden();
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
    this.remote = null;
    this.store = null;
    if (this.pluginReloadTimer !== null) {
      window.clearTimeout(this.pluginReloadTimer);
      this.pluginReloadTimer = null;
    }
    for (const id of this.connectIntervals) window.clearInterval(id);
    this.connectIntervals = [];
    this.statusBar?.setInactive();
  }

  private currentCtx() {
    return { isMobile: Platform.isMobile, onWifi: this.isOnWifi(), wifiOnly: this.settings.wifiOnly };
  }

  private onHiddenApplied(path: string): void {
    if (!path.startsWith(".obsidian/plugins/")) return;
    this.pluginChanges.add(path);
    if (this.pluginReloadTimer !== null) window.clearTimeout(this.pluginReloadTimer);
    this.pluginReloadTimer = window.setTimeout(() => this.promptPluginReload(), 3000);
  }

  private promptPluginReload(): void {
    const ids = planPluginReload([...this.pluginChanges]);
    this.pluginChanges.clear();
    this.pluginReloadTimer = null;
    if (ids.length === 0) return;
    const notice = new Notice(`Vaultbridge: Plugins aktualisiert (${ids.join(", ")}). Zum Neuladen hier klicken.`, 0);
    notice.noticeEl.style.cursor = "pointer";
    notice.noticeEl.addEventListener("click", async () => {
      notice.hide();
      for (const id of ids) {
        try {
          // @ts-ignore - app.plugins ist intern, aber stabil genug für diesen Zweck
          await this.app.plugins.disablePlugin(id);
          // @ts-ignore
          await this.app.plugins.enablePlugin(id);
        } catch (e) {
          new Notice(`Vaultbridge: Neu laden von ${id} fehlgeschlagen: ${String(e)}`);
        }
      }
      new Notice("Plugins neu geladen.");
    });
  }

  private isOnWifi(): boolean {
    const conn = (navigator as unknown as { connection?: { type?: string } }).connection;
    if (conn && typeof conn.type === "string") return conn.type === "wifi" || conn.type === "ethernet";
    return navigator.onLine; // Fallback: kein WLAN-Typ verfügbar -> online als "ok" werten
  }

  async syncOnce(): Promise<void> {
    if (!this.localDb || !this.remote) { new Notice("Vaultbridge: nicht verbunden."); return; }
    await new Promise<void>((resolve) => {
      startSync(this.localDb!, this.remote!, { live: false }, (s, info) => {
        this.statusBar.setStatus(s, info);
        if (s === "idle" || s === "error") resolve();
      });
    });
    await this.bridge?.reconcileHidden();
    void this.refreshConflicts();
  }

  private async refreshConflicts(): Promise<void> {
    if (!this.store) {
      this.statusBar.setConflicts(0);
      return;
    }
    try {
      const ids = await this.store.listConflicts();
      this.statusBar.setConflicts(ids.length);
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)) {
        const view = leaf.view;
        if (view instanceof ConflictListView) void view.render();
      }
    } catch {
      /* Konfliktprüfung ist best-effort */
    }
  }

  async openConflictView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)[0] ?? null;
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) { new Notice("Vaultbridge: kein Panel verfügbar."); return; }
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.rules = {
      ...this.settings.rules,
      include: [...this.settings.rules.include],
      exclude: [...this.settings.rules.exclude],
    };
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
