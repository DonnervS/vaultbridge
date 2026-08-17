import { EventRef, Menu, Notice, Platform, Plugin, TAbstractFile, requestUrl } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";
import { makeRequestUrlFetch } from "./store/obsidianFetch";
import { StatusBar } from "./ui/StatusBar";
import { decodeSetup, encodeSetup } from "./setup/setupString";
import { deriveKeys, encryptBytes, decryptBytes, pathId, VaultKeys } from "./crypto/crypto";
import { base64urlToBytes, bytesToBase64url, utf8 } from "./crypto/encoding";
import { PouchDB } from "./store/pouch";
import { VaultStore } from "./store/store";
import type { ConflictVersion } from "./store/store";
import { startSync, SyncHandle, SyncStatus } from "./store/replication";
import { EchoGuard, contentHash } from "./vault/applyChange";
import { planAutoResolve, planResolutionStep, ConflictBranch } from "./conflicts/autoResolve";
import { VaultBridge } from "./vault/bridge";
import { DEFAULT_RULES, SyncRules, migrateRules, syncRuleState, setInclusion } from "./vault/rules";
import { promptPassphrase } from "./ui/PassphrasePromptModal";
import { ConflictListView, VIEW_TYPE_CONFLICTS } from "./ui/ConflictListView";
import { ConflictDiffView, VIEW_TYPE_CONFLICT_DIFF } from "./ui/ConflictDiffView";
import { SyncMode, shouldReplicateNow } from "./store/syncModes";
import { planPluginReload } from "./plugins/pluginSync";
import { GeneratorModal } from "./ui/GeneratorModal";
import { HistoryModal } from "./ui/HistoryModal";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "./crypto/rotation";
import { initialPullKey } from "./store/initialSync";
import { defaultDeviceName, randomDeviceSuffix } from "./setup/deviceName";

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
  // Lokal bekannte Passphrase-Epoche (M6): erhöht sich bei jeder Rotation,
  // dient dem Vergleich gegen den im Store abgelegten Epoch-Marker.
  epoch: number;
  // Beim Start automatisch verbinden, sobald der Workspace bereit ist. Spart den
  // manuellen Befehl "Vaultbridge: Verbinden". Bei getrennter Passphrase (pp:
  // "separate") wird diese beim Autostart per Prompt abgefragt.
  autostart: boolean;
  // Pro Server+Datenbank: wurde gegen diesen Datenbestand schon einmal
  // vollständig gepullt? Erst dann darf der Erst-Upload laufen. Ohne diesen
  // Riegel lädt ein frisch verbundenes Gerät seinen kompletten Vault gegen
  // einen leeren Store hoch und erzeugt auf jeder Datei einen Konflikt.
  initialPullDone: Record<string, boolean>;
  // Transportweg zur CouchDB. "fetch" (Standard) ist das Browser-fetch mit
  // Streaming — bewährt und unverändert. "requestUrl" leitet über Obsidians
  // eigene HTTP-Schicht um und umgeht damit CORS und Chromiums Local Network
  // Access; nötig, wenn die CouchDB auf einer lokalen Adresse läuft.
  transport: "fetch" | "requestUrl";
}

const DEFAULT_SETTINGS: VaultbridgeSettings = {
  setupString: "",
  deviceName: "",
  rules: { ...DEFAULT_RULES, include: [...DEFAULT_RULES.include], exclude: [...DEFAULT_RULES.exclude] },
  known: {},
  syncMode: "continuous",
  wifiOnly: false,
  intervalSeconds: 120,
  epoch: 0,
  autostart: true,
  initialPullDone: {},
  transport: "fetch",
};

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = { ...DEFAULT_SETTINGS };
  private statusBar!: StatusBar;
  private syncHandle: SyncHandle | null = null;
  private bridge: VaultBridge | null = null;
  private localDb: PouchDB.Database | null = null;
  private remote: PouchDB.Database | null = null;
  private store: VaultStore | null = null;
  private keysForHistory: VaultKeys | null = null;
  private pluginChanges = new Set<string>();
  private pluginReloadTimer: number | null = null;
  private connectIntervals: number[] = [];
  // EventRefs der (onOpenClose-)Quit-Handler, damit stopSyncStack() sie neben
  // registerEvent() (Unload-Sicherheit) auch manuell abräumen kann — nötig,
  // weil restartSync()/rotatePassphrase() sie schon zur Laufzeit ersetzen,
  // lange vor onunload().
  private syncEventRefs: EventRef[] = [];
  private knownSaveTimer: number | null = null;
  // Schützt gegen doppelte Adoptions-Prompts: connect() ruft checkAdoption()
  // direkt auf, kurz danach kann der erste Sync-Settle (onSyncStatus) sie
  // erneut auslösen.
  private checkingAdoption = false;
  // Verhindert zwei nebenläufige rotatePassphrase()-Läufe (z.B. Rotation
  // starten, Modal per Escape schließen, erneut öffnen + bestätigen) — zwei
  // gleichzeitige store.rotate()-Aufrufe mit unterschiedlichen Schlüsseln
  // würden den Store beschädigen.
  private rotating = false;
  // Verhindert, dass zwei Settles gleichzeitig auflösen.
  private autoResolving = false;
  // Schlüssel (Server+DB) der aktuellen Verbindung, für settings.initialPullDone.
  private currentPullKey: string | null = null;
  // Läuft gerade ein nachgeholter Erst-Pull? Sonst startet jedes Sync-Settle
  // eine weitere vollständige Replikation, während die erste noch läuft.
  private catchingUpPull = false;
  // Zählt jede connect()-Runde. connect() legt seine Ressourcen ERST NACH den
  // awaits an (Passphrase-Prompt, PBKDF2) — das disconnect() an seinem Anfang
  // kann sie also nicht kennen. Wird währenddessen erneut verbunden oder das
  // Plugin entladen, erkennt die überholte Runde das hieran und räumt sich
  // selbst ab, statt sich nachträglich in die Felder zu schreiben.
  private connectGeneration = 0;
  // Aktuell im Diff-Bereich (ConflictDiffView) geöffneter Konflikt. Von der
  // Liste (rechts) gesetzt, von der Diff-View (Mitte) gelesen.
  private activeConflictId: string | null = null;
  // Als Feld (statt lokale Closure in connect()), damit restartSync() nach
  // einer Passphrase-Rotation denselben Status-Handler wiederverwenden kann.
  private readonly onSyncStatus = (s: SyncStatus, info?: string): void => {
    this.statusBar.setStatus(s, info);
    if (s === "idle" || s === "paused") {
      // Erst-Pull ausschließlich bei "paused" nachziehen. "idle" entsteht hier
      // aus dem complete-Event, und das liefert ein LIVE-Sync nur beim Abbruch
      // (cancel) — also beim Abbau der Verbindung, etwa aus restartSync() oder
      // der Rotationspause heraus. Ein Riegel-Vermerk an dieser Stelle würde
      // einen nie gelaufenen Erst-Pull als erledigt festschreiben.
      if (s === "paused") void this.catchUpInitialPull();
      // Bei JEDEM Settle nachziehen (nicht nur einmal): der Pull kommt in Schüben,
      // und Notizen, deren Chunks in einem früheren Schub noch fehlten, werden erst
      // in einer späteren Runde dekodierbar. reconcileFromStore ist nach dem ersten
      // vollständigen Durchlauf billig (nur neue/verpasste IDs).
      void this.bridge?.reconcileFromStore();
      void this.refreshConflicts();
      void this.bridge?.reconcileHidden();
      void this.checkAdoption();
    }
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    // Klick auf das Konflikt-Badge öffnet direkt die Konflikt-Ansicht — kein
    // Umweg über die Befehlspalette nötig.
    this.statusBar = new StatusBar(this.addStatusBarItem(), () => void this.openConflictView());
    this.addSettingTab(new VaultbridgeSettingsTab(this.app, this));
    this.addCommand({ id: "connect", name: "Verbinden", callback: () => void this.connect() });
    this.addCommand({ id: "disconnect", name: "Trennen", callback: () => this.disconnect() });
    // Autostart (settings.autostart) verbindet am Ende von onload() via
    // onLayoutReady automatisch. Der manuelle Befehl "Vaultbridge: Verbinden"
    // bleibt für den Fall, dass Autostart aus ist oder man neu verbinden will.

    this.registerView(
      VIEW_TYPE_CONFLICTS,
      (leaf) => new ConflictListView(
        leaf,
        () => this.store,
        (id) => void this.openConflictDiff(id),
        () => this.activeConflictId,
        () => void this.resolveIdenticalConflicts(),
      ),
    );
    this.registerView(
      VIEW_TYPE_CONFLICT_DIFF,
      (leaf) => new ConflictDiffView(
        leaf,
        () => this.store,
        () => this.activeConflictId,
        (id) => void this.onConflictResolved(id),
      ),
    );
    this.addCommand({
      id: "show-conflicts",
      name: "Konflikte anzeigen",
      callback: () => void this.openConflictView(),
    });
    this.addCommand({
      // id bewusst unverändert: Obsidian löst Hotkeys über die id auf, eine
      // Änderung würde bereits vom Nutzer gesetzte Tastenkürzel stillschweigend brechen.
      id: "resolve-identical-conflicts",
      name: "Konflikte jetzt auflösen",
      callback: () => void this.resolveIdenticalConflicts(),
    });
    this.addCommand({
      id: "sync-now",
      name: "Jetzt synchronisieren",
      callback: () => void this.syncOnce(),
    });
    this.addCommand({
      id: "generate-setup",
      name: "Setup-String erzeugen",
      callback: () =>
        new GeneratorModal(this.app, async (setupString) => {
          this.settings.setupString = setupString;
          await this.saveSettings();
        }).open(),
    });
    this.addCommand({
      id: "file-history",
      name: "Datei-Verlauf anzeigen",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.store) return false;
        if (!checking) void this.openHistory(file.path);
        return true;
      },
    });

    // Regelmäßiger Abgleich versteckter Dateien (Dotfiles/.claude/Plugins):
    // diese lösen keine indizierten Vault-Events aus, daher periodisches Polling.
    this.registerInterval(window.setInterval(() => { if (!this.rotating) void this.bridge?.reconcileHidden(); }, 30000));

    // Kontextmenü im Dateibaum: Ordner/Datei direkt vom Sync aus- oder wieder
    // einschließen (kontextabhängig je nach aktuellem Regel-Zustand).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => this.addSyncMenuItem(menu, file)),
    );

    // Autostart: nach dem Aufbau des Workspace automatisch verbinden, sofern
    // aktiviert und ein Setup-String hinterlegt ist. onLayoutReady stellt sicher,
    // dass der Vault-Adapter bereit ist, bevor die Bridge Dateien liest; feuert
    // auch dann, wenn der Layout-Aufbau schon abgeschlossen ist (Plugin zur
    // Laufzeit aktiviert).
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autostart && this.settings.setupString) void this.connect();
    });
  }

  onunload(): void {
    this.disconnect();
  }

  async connect(): Promise<void> {
    this.disconnect(); // vorherige Verbindung sauber beenden
    const generation = ++this.connectGeneration;
    // Ist diese Runde von einem weiteren connect(), einem disconnect() oder dem
    // Entladen des Plugins überholt worden? Dann darf sie nichts mehr in die
    // Felder schreiben: sonst bleiben Vault-Listener und eine PouchDB-Instanz
    // zurück, die niemand mehr stoppen kann. Bewusst KEIN close() auf die
    // eigene PouchDB in diesem Fall — PouchDB teilt die IndexedDB-Verbindung
    // pro Datenbankname (cachedDBs), ein close() hier würde die Verbindung der
    // inzwischen gültigen Instanz mit schließen.
    const stale = (): boolean => generation !== this.connectGeneration;
    let ownBridge: VaultBridge | null = null;
    const abandon = (): void => { ownBridge?.stop(); };
    try {
      const payload = decodeSetup(this.settings.setupString);
      let passphrase = payload.passphrase ?? "";
      if (payload.pp === "separate") {
        passphrase = (await promptPassphrase(this.app, "Passphrase eingeben")) ?? "";
        if (stale()) return;
        if (!passphrase) { new Notice("Vaultbridge: keine Passphrase, abgebrochen."); return; }
      }
      const keys = await deriveKeys(passphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
      if (stale()) return;
      this.keysForHistory = keys;
      this.localDb = new PouchDB(`vaultbridge-${payload.db}`);
      const store = new VaultStore(this.localDb, keys, payload.opts.chunkSize);
      this.store = store;
      const guard = new EchoGuard();
      this.currentPullKey = initialPullKey(payload.couchUrl, payload.db);
      // Erst beim Verbinden vorbelegen, nicht beim Laden: hier steht fest, dass
      // das Gerät wirklich am Sync teilnimmt, und der Name landet ab sofort in
      // jeder geschriebenen Datei.
      if (!this.settings.deviceName) {
        this.settings.deviceName = defaultDeviceName(
          {
            isMacOS: Platform.isMacOS,
            isWin: Platform.isWin,
            isIosApp: Platform.isIosApp,
            isAndroidApp: Platform.isAndroidApp,
            isTablet: Platform.isTablet,
          },
          randomDeviceSuffix(),
        );
        await this.saveSettings();
        // saveSettings() ist echtes Disk-I/O (siehe unten) — also ein neuer
        // await-Punkt wie jeder andere in dieser Runde. ownBridge existiert an
        // dieser Stelle noch nicht (wird erst unten gesetzt), daher hier wie
        // bei den beiden vorherigen Prüfungen (Passphrase-Prompt, deriveKeys)
        // ohne abandon() — es gibt noch nichts abzuräumen.
        if (stale()) return;
      }
      this.bridge = new VaultBridge(
        this.app,
        store,
        guard,
        this.settings.rules ?? DEFAULT_RULES,
        this.app.vault.configDir,
        () => new Map(Object.entries(this.settings.known ?? {})),
        (m) => {
          this.settings.known = Object.fromEntries(m);
          if (this.knownSaveTimer !== null) window.clearTimeout(this.knownSaveTimer);
          this.knownSaveTimer = window.setTimeout(() => { this.knownSaveTimer = null; void this.saveSettings(); }, 2000);
        },
        () => this.settings.deviceName,
        (p) => this.onHiddenApplied(p),
      );
      ownBridge = this.bridge;
      // Sicherheitsnetz gegen genau den Fall, der diesen Fehler erzeugt hat:
      // Wird das Plugin entladen, während connect() noch in einem await steht,
      // läuft onunload()/disconnect() ins Leere und die gleich registrierten
      // Vault-Listener würden diese Plugin-Instanz überleben — und dann bei
      // JEDER Dateiänderung gegen eine geschlossene IndexedDB-Verbindung
      // schreiben. Component.register() räumt sie beim Unload zuverlässig ab,
      // unabhängig davon, ob disconnect() sie erwischt. stop() ist idempotent.
      this.register(() => ownBridge?.stop());
      // Listener sofort aktiv, Erst-Upload aber gesperrt (siehe runInitialUpload).
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, {
        auth: { username: payload.user, password: payload.pass },
        ...(this.settings.transport === "requestUrl"
          ? { fetch: makeRequestUrlFetch(requestUrl) }
          : {}),
      });
      this.remote = remote;

      if (this.settings.initialPullDone[this.currentPullKey]) {
        await this.bridge.runInitialUpload();
      } else {
        // Erst ziehen, dann schieben. Diese Reihenfolge ist der eigentliche Fix
        // gegen flächendeckende Konflikte beim Hinzufügen eines Geräts.
        this.statusBar.setStatus("active", "Erstabgleich …");
        try {
          await this.localDb.replicate.from(remote);
          if (stale()) { abandon(); return; } // zwischenzeitlich getrennt
          await this.bridge.reconcileFromStore();
          // Auch hier: reconcileFromStore() schreibt den ganzen Store in den
          // Vault und dauert entsprechend. markInitialPullDone() liest danach
          // wieder die Felder (currentPullKey, bridge) — eine überholte Runde
          // würde den Riegel der NEUEN Verbindung setzen, deren Pull noch gar
          // nicht gelaufen ist.
          if (stale()) { abandon(); return; }
          await this.markInitialPullDone();
          this.statusBar.setStatus("idle"); // Erstabgleich durch
        } catch (e) {
          // Ohne eigenen Status bliebe im manuellen Modus (kein weiteres
          // Sync-Event) dauerhaft "Erstabgleich …" stehen.
          this.statusBar.setStatus("error", "Erstabgleich ausstehend");
          new Notice(
            "Vaultbridge: Erstabgleich noch nicht möglich — es wird vorerst nichts hochgeladen. " +
              `Sobald die Verbindung steht, wird er automatisch nachgeholt. (${String(e)})`,
            10000,
          );
        }
      }
      if (stale()) { abandon(); return; }

      this.startSyncForMode();

      new Notice("Vaultbridge verbunden.");
      void this.refreshConflicts();
      void this.checkAdoption();
    } catch (e) {
      // Überholte Runde: nur die eigenen Listener abräumen. Ein disconnect()
      // würde hier die inzwischen gültige Verbindung zerstören.
      if (stale()) { abandon(); return; }
      this.disconnect();
      this.statusBar.setStatus("error", String(e));
      new Notice(`Vaultbridge: Verbindung fehlgeschlagen: ${String(e)}`);
    }
  }

  disconnect(): void {
    // Generation erhöhen, BEVOR die Verbindung fällt: eine noch laufende
    // connect()-Runde erkennt daran, dass sie überholt ist, und schreibt sich
    // nicht nachträglich in die gerade geräumten Felder.
    this.connectGeneration++;
    this.stopSyncStack();
    this.bridge = null;
    this.currentPullKey = null;
    // Ein noch laufender Nach-Pull gehört zur alten Verbindung; er erkennt das
    // an der Generation und schreibt nichts mehr. Die Sperre darf die neue
    // Verbindung aber nicht blockieren, bis er abgelaufen ist.
    this.catchingUpPull = false;
    void this.localDb?.close();
    this.localDb = null;
    this.remote = null;
    this.store = null;
    this.keysForHistory = null;
    if (this.pluginReloadTimer !== null) {
      window.clearTimeout(this.pluginReloadTimer);
      this.pluginReloadTimer = null;
    }
    if (this.knownSaveTimer !== null) {
      window.clearTimeout(this.knownSaveTimer);
      this.knownSaveTimer = null;
      void this.saveSettings();
    }
    this.statusBar?.setInactive();
  }

  /**
   * Räumt sämtliche sync-treibenden Registrierungen ab: den laufenden
   * SyncHandle (kontinuierlicher Live-Sync), die Bridge, alle Intervall-Timer
   * (interval-Modus) und alle Quit-Handler (onOpenClose-Modus). Zentral
   * genutzt von disconnect(), restartSync() und rotatePassphrase() (Pause vor
   * store.rotate()) — sonst laufen Intervall-Timer/Quit-Handler während der
   * Rotation weiter (nebenläufige Schreibungen) bzw. werden bei jedem Neustart
   * doppelt registriert (Leak).
   */
  private stopSyncStack(): void {
    this.syncHandle?.stop();
    this.syncHandle = null;
    this.bridge?.stop();
    for (const id of this.connectIntervals) window.clearInterval(id);
    this.connectIntervals = [];
    for (const ref of this.syncEventRefs) this.app.workspace.offref(ref);
    this.syncEventRefs = [];
  }

  /**
   * (Re-)startet Bridge + Sync (im gemäß settings.syncMode konfigurierten
   * Modus, nicht hartkodiert live) mit dem aktuellen Store/Schlüsseln. Wird
   * von rotatePassphrase() genutzt, um nach der Zwangspause während
   * store.rotate() wieder aufzunehmen.
   */
  private restartSync(): void {
    if (!this.localDb || !this.remote) return;
    this.stopSyncStack(); // idempotente Teilräumung vor dem Neustart — sonst Leak (doppelte Timer/Handler)
    this.bridge?.start();
    this.startSyncForMode();
  }

  /**
   * Wählt anhand von settings.syncMode (+ Mobile/WLAN-Heuristik) die
   * passende Sync-Strategie und startet sie: kontinuierlich (live-Sync),
   * intervallbasiert (registerInterval + shouldReplicateNow-Gate), bei
   * Öffnen/Schließen (syncOnce + quit-Handler) oder manuell (kein
   * automatischer Trigger, nur der "Sync jetzt"-Befehl). Von connect()
   * (Erstverbindung) UND restartSync() (Wiederaufnahme nach Passphrase-
   * Rotation) genutzt — deshalb ausschließlich über Felder (this.localDb,
   * this.remote), keine lokalen Closures aus connect().
   */
  private startSyncForMode(): void {
    if (!this.localDb || !this.remote) return;
    const mode = this.settings.syncMode;
    const effectiveMode =
      mode === "continuous" && Platform.isMobile && this.settings.wifiOnly ? "interval" : mode;
    if (effectiveMode === "continuous" && shouldReplicateNow(effectiveMode, this.currentCtx())) {
      this.syncHandle = startSync(this.localDb, this.remote, { live: true }, this.onSyncStatus);
    } else if (effectiveMode === "interval") {
      const id = this.registerInterval(
        window.setInterval(() => {
          if (shouldReplicateNow(effectiveMode, this.currentCtx())) void this.syncOnce();
        }, this.settings.intervalSeconds * 1000),
      );
      this.connectIntervals.push(id);
    } else if (effectiveMode === "onOpenClose") {
      if (shouldReplicateNow(effectiveMode, this.currentCtx())) void this.syncOnce();
      const ref = this.app.workspace.on("quit", (tasks) => {
        if (shouldReplicateNow(effectiveMode, this.currentCtx())) tasks.addPromise(this.syncOnce());
      });
      this.registerEvent(ref);
      this.syncEventRefs.push(ref);
    }
    // manual: nur der "Sync jetzt"-Befehl
  }

  private currentCtx() {
    return { isMobile: Platform.isMobile, onWifi: this.isOnWifi(), wifiOnly: this.settings.wifiOnly };
  }

  private onHiddenApplied(path: string): void {
    if (!path.startsWith(`${this.app.vault.configDir}/plugins/`)) return;
    this.pluginChanges.add(path);
    if (this.pluginReloadTimer !== null) window.clearTimeout(this.pluginReloadTimer);
    this.pluginReloadTimer = window.setTimeout(() => this.promptPluginReload(), 3000);
  }

  private promptPluginReload(): void {
    const ids = planPluginReload([...this.pluginChanges], this.app.vault.configDir);
    this.pluginChanges.clear();
    this.pluginReloadTimer = null;
    if (ids.length === 0) return;
    // Rein informativ: Vaultbridge lädt keine Plugins mehr programmatisch neu
    // (kein disablePlugin/enablePlugin). Der Nutzer entscheidet selbst, wann er
    // neu lädt.
    new Notice(
      `Vaultbridge: Plugins aktualisiert (${ids.join(", ")}). ` +
        "Zum Übernehmen Obsidian neu laden oder die betroffenen Plugins aus- und wieder einschalten.",
      0,
    );
  }

  private isOnWifi(): boolean {
    const conn = (navigator as unknown as { connection?: { type?: string } }).connection;
    if (conn && typeof conn.type === "string") return conn.type === "wifi" || conn.type === "ethernet";
    return navigator.onLine; // Fallback: kein WLAN-Typ verfügbar -> online als "ok" werten
  }

  async syncOnce(): Promise<void> {
    if (this.rotating) { new Notice("Vaultbridge: Rotation läuft — Sync pausiert."); return; }
    if (!this.localDb || !this.remote) { new Notice("Vaultbridge: nicht verbunden."); return; }
    const generation = this.connectGeneration;
    const last = await new Promise<SyncStatus>((resolve) => {
      startSync(this.localDb!, this.remote!, { live: false }, (s, info) => {
        this.statusBar.setStatus(s, info);
        if (s === "idle" || s === "error") resolve(s);
      });
    });
    await this.bridge?.reconcileFromStore();
    await this.bridge?.reconcileHidden();
    // Beim Einmal-Sync (live: false) heißt "idle" wirklich "durchgelaufen"
    // (complete) — in den Modi ohne Live-Sync (interval, onOpenClose, manual)
    // der einzige Nachweis für einen vollständigen Pull. Erst danach, damit
    // reconcileHidden() nicht doppelt läuft (runInitialUpload erledigt es).
    // Nur bei unveränderter Verbindung: sonst würde der Nachweis dieses Syncs
    // dem Riegel einer inzwischen anderen Datenbank gutgeschrieben.
    if (last === "idle" && generation === this.connectGeneration) await this.markInitialPullDone();
    void this.refreshConflicts();
  }

  /**
   * Rotiert die Vault-Passphrase: verifiziert die alte Passphrase, pausiert
   * Bridge + Sync (KRITISCH — verhindert nebenläufige Schreibungen während
   * store.rotate() die Notizen einsammelt/neu verschlüsselt), rotiert alle
   * Dateien auf den neuen Schlüssel, schreibt den Epoch-Marker und startet
   * Bridge + Sync mit den neuen Schlüsseln neu.
   */
  async rotatePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.rotating) { new Notice("Vaultbridge: Es läuft bereits eine Rotation."); return false; }
    this.rotating = true;
    try {
      if (!this.store || !this.localDb || !this.remote || !this.keysForHistory) {
        new Notice("Vaultbridge: nicht verbunden.");
        return false;
      }
      const payload = decodeSetup(this.settings.setupString);
      // 1. Alte Passphrase verifizieren: Probe mit dem aktuellen Schlüssel
      // ver-, mit dem aus der eingegebenen alten Passphrase abgeleiteten
      // Schlüssel entschlüsseln.
      const oldKeys = await deriveKeys(oldPassphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
      const probe = await encryptBytes(this.keysForHistory.contentKey, utf8.encode("vaultbridge-probe"));
      try {
        if (utf8.decode(await decryptBytes(oldKeys.contentKey, probe)) !== "vaultbridge-probe") throw new Error();
      } catch {
        new Notice("Vaultbridge: alte Passphrase falsch.");
        return false;
      }
      // 2. Neuen Schlüssel ableiten.
      const newSalt = crypto.getRandomValues(new Uint8Array(16));
      const newKeys = await deriveKeys(newPassphrase, newSalt, payload.kdfIter);
      // Vor-Rotations-Zustand sichern — falls ein Fehler NACH dem Finalisieren
      // auftritt (z.B. saveSettings() schlägt auf Mobile/Disk-I/O fehl), muss
      // der catch-Block nicht nur den Store-Schlüssel zurückdrehen, sondern
      // auch keysForHistory/epoch/setupString wieder in Deckung bringen —
      // sonst verschlüsselt die alte-Passphrase-Probe der NÄCHSTEN Rotation
      // mit keysForHistory (fälschlich noch newKeys) gegen die korrekt neu
      // abgeleiteten oldKeys und schlägt fehl: falsches "alte Passphrase
      // falsch" genau auf dem Retry-Pfad, den das Modal anbietet.
      const prevKeysForHistory = this.keysForHistory;
      const prevEpoch = this.settings.epoch;
      const prevSetupString = this.settings.setupString;
      // 3. Bridge + Sync PAUSIEREN — keine nebenläufigen Schreibungen während
      // rotate(). Muss auch Intervall-Timer (interval-Modus) und Quit-Handler
      // (onOpenClose-Modus) abräumen, sonst feuern die während store.rotate()
      // weiter und schreiben nebenläufig.
      this.stopSyncStack();
      // 4.-5. Rotieren + finalisieren (Epoch-Marker, lokale Config) — beides in
      // EINEM try, damit ein Fehler in JEDEM Teilschritt (rotate() selbst ODER
      // Marker/Settings/Setup-String danach) denselben Revert + Resume auslöst.
      try {
        await this.store.rotate(newKeys, onProgress, signal);
        // 5. Epoch-Marker + lokale Config aktualisieren.
        const epoch = (this.settings.epoch ?? 0) + 1;
        await this.store.writeEpochMarker({
          epoch,
          kdfSalt: bytesToBase64url(newSalt),
          kdfIter: payload.kdfIter,
          verify: await makeVerifyToken(newKeys, epoch),
        });
        this.settings.epoch = epoch;
        this.settings.setupString = encodeSetup({
          ...payload,
          kdfSalt: bytesToBase64url(newSalt),
          ...(payload.pp === "embedded" ? { passphrase: newPassphrase } : {}),
        });
        this.keysForHistory = newKeys;
        await this.saveSettings();
        return true;
      } catch (e) {
        // Encoder zurück auf den ALTEN Schlüssel drehen (neu bleibt als
        // Lese-Fallback erhalten) — sonst verschlüsselt der Store bei einer
        // abgebrochenen Rotation weiter mit newKeys, während Settings/
        // keysForHistory noch auf dem alten Schlüssel stehen: spätere
        // Änderungen würden unter einem Schlüssel verschlüsselt, den kein
        // Peer kennt (stiller Ein-Weg-Sync-Stillstand).
        this.store.setKeys(oldKeys, newKeys);
        // In-memory Config im selben Zug zurückdrehen wie den Store-Schlüssel
        // — siehe Kommentar bei der Sicherung oben.
        this.keysForHistory = prevKeysForHistory;
        this.settings.epoch = prevEpoch;
        this.settings.setupString = prevSetupString;
        throw e;
      } finally {
        // 6. Bridge + Sync IMMER wieder aufnehmen — Erfolg wie Fehler,
        // sonst bleibt der Sync bei einem Finalisierungsfehler dauerhaft
        // pausiert.
        this.restartSync();
      }
    } finally {
      this.rotating = false;
    }
  }

  /**
   * Prüft, ob eine Passphrase-Rotation auf einem anderen Gerät stattgefunden
   * hat (Epoch-Marker im Store höher als die lokal bekannte Epoche) und holt
   * die neue Passphrase in diesem Fall per Prompt ein.
   */
  async checkAdoption(): Promise<void> {
    if (this.checkingAdoption) return;
    if (!this.store || !this.keysForHistory) return;
    // Guard VOR dem ersten await setzen (nicht erst nach readEpochMarker()) —
    // sonst können zwei gleichzeitige Aufrufe (connect() + onSyncStatus-Settle)
    // beide den Marker lesen, bevor der erste die Flagge setzt, und beide den
    // Adoptions-Prompt öffnen (TOCTOU).
    this.checkingAdoption = true;
    try {
      const marker = await this.store.readEpochMarker();
      if (!needsAdoption(this.settings.epoch ?? 0, marker)) return;
      new Notice("Vaultbridge: Die Passphrase wurde auf einem anderen Gerät geändert.");
      const pass = await promptPassphrase(this.app, "Neue Passphrase eingeben");
      if (!pass) return;
      const candidate = await deriveKeys(pass, base64urlToBytes(marker!.kdfSalt), marker!.kdfIter);
      if (!(await checkVerifyToken(candidate, marker!.epoch, marker!.verify))) {
        new Notice("Vaultbridge: Passphrase falsch.");
        return;
      }
      this.store.setKeys(candidate, this.keysForHistory); // neu=current, alt=previous (Ring liest beide)
      this.keysForHistory = candidate;
      this.settings.epoch = marker!.epoch;
      const payload = decodeSetup(this.settings.setupString);
      this.settings.setupString = encodeSetup({
        ...payload,
        kdfSalt: marker!.kdfSalt,
        ...(payload.pp === "embedded" ? { passphrase: pass } : {}),
      });
      await this.saveSettings();
      new Notice("Vaultbridge: Neue Passphrase übernommen.");
    } finally {
      this.checkingAdoption = false;
    }
  }

  /** Ist der Erstabgleich für die aktuelle Verbindung durch? */
  private initialPullSettled(): boolean {
    return !!this.currentPullKey && this.settings.initialPullDone[this.currentPullKey] === true;
  }

  /**
   * Merkt den abgeschlossenen Erst-Pull und gibt den Erst-Upload frei.
   * Aufgerufen nach dem expliziten Pull in connect() UND aus onSyncStatus:
   * ein sauber durchgelaufener Sync-Zyklus ist derselbe Nachweis wie ein
   * abgeschlossener Einzel-Pull. Damit holt sich ein Gerät, das offline
   * gestartet ist, den Erstabgleich beim ersten erfolgreichen Settle.
   */
  private async markInitialPullDone(): Promise<void> {
    const key = this.currentPullKey;
    // Bridge in eine lokale Variable: nach dem await unten kann das Feld
    // durch ein zwischenzeitliches disconnect() null sein. runInitialUpload()
    // auf einer gestoppten Bridge ist harmlos (sie bricht selbst ab).
    const bridge = this.bridge;
    if (!key || !bridge) return;
    if (this.settings.initialPullDone[key] !== true) {
      // Bewusst neues Objekt statt In-Place-Mutation: ohne eigenes
      // initialPullDone in data.json zeigt settings.initialPullDone auf das
      // geteilte Objekt aus DEFAULT_SETTINGS (Object.assign kopiert flach).
      this.settings.initialPullDone = { ...this.settings.initialPullDone, [key]: true };
      await this.saveSettings();
    }
    await bridge.runInitialUpload();
  }

  /**
   * Holt aus einem Sync-Settle heraus den Erst-Pull nach, wenn er beim
   * Verbinden nicht möglich war (offline gestartetes Gerät). Ohne dieses
   * Nachholen bliebe der Erst-Upload die ganze Sitzung gesperrt — und die in
   * der Zwischenzeit gelöschten Dateien stehen nur in der Warteschlange im
   * Arbeitsspeicher der Bridge.
   *
   * Nachweis für einen durchgelaufenen Pull ist ausschließlich ein erfolgreich
   * aufgelöstes replicate.from(), NICHT das "paused" des Live-Syncs: PouchDBs
   * Sync-Wrapper reicht das Fehlerargument seiner beiden Richtungen nicht
   * weiter (pushPaused/pullPaused emittieren 'paused' ohne err), ein Backoff
   * nach Verbindungsfehler ist dort von "eingeholt" also nicht zu
   * unterscheiden. Ausgerechnet das offline gestartete Gerät würde sonst
   * seinen Vault gegen einen leeren Store hochladen. Der Nach-Pull ist billig:
   * er teilt den Checkpoint mit dem Pull des Live-Syncs und findet im
   * Normalfall nichts mehr zu holen.
   */
  private async catchUpInitialPull(): Promise<void> {
    if (this.rotating) return; // während store.rotate() nicht replizieren
    // Riegel steht schon: nur den (von einem stop() zurückgerollten)
    // Erst-Upload wieder freigeben. Idempotent, kein Pull nötig.
    if (this.initialPullSettled()) { await this.markInitialPullDone(); return; }
    if (this.catchingUpPull) return;
    const localDb = this.localDb;
    const remote = this.remote;
    const bridge = this.bridge;
    if (!localDb || !remote || !bridge) return;
    // Wie in connect(): nach jedem await darf eine überholte Runde den Riegel
    // der inzwischen gültigen Verbindung nicht setzen.
    const generation = this.connectGeneration;
    this.catchingUpPull = true;
    try {
      await localDb.replicate.from(remote);
      if (generation !== this.connectGeneration) return;
      // Erst in den Vault materialisieren, dann den Riegel lösen — dieselbe
      // Reihenfolge wie in connect(). Sonst liegen die frisch gezogenen Notizen
      // zwar im Store, aber noch nicht als Dateien vor, und reconcileExisting()
      // schiebt die veraltete lokale Fassung darüber. Der Live-Feed erledigt
      // das NICHT verlässlich: er läuft ungewartet nebenher und überspringt
      // Notizen, deren Chunks noch nicht da sind. reconcileFromStore() wartet
      // dafür auf einen Durchlauf, der nach diesem Pull begonnen hat.
      await bridge.reconcileFromStore();
      if (generation !== this.connectGeneration) return;
      await this.markInitialPullDone();
    } catch {
      /* offline oder Serverfehler: beim nächsten Settle erneut versuchen */
    } finally {
      this.catchingUpPull = false;
    }
  }

  /**
   * Löst Konflikte automatisch auf, sobald das gefahrlos möglich ist:
   * inhaltsgleiche Zweige werden still verworfen, bei echten Abweichungen
   * gewinnt die neuere Fassung und die unterlegene wird als Sidecar gesichert
   * und gemeldet. Läuft bei jedem Sync-Settle.
   *
   * Löschungen sind gewöhnliche Zweige (VaultStore.deleteFile markiert nur),
   * eine Löschung gegen eine Bearbeitung also ein Allerweltsfall. Er wird in
   * beide Richtungen sauber entschieden:
   * - Die Löschung ist neuer -> die Datei bleibt überall gelöscht, der
   *   unterlegene INHALT wird als Sidecar gesichert (er steht auf dem Spiel).
   * - Die Bearbeitung ist neuer -> die Datei bleibt mit ihrem Inhalt erhalten;
   *   kein Sidecar, weil eine Löschung nichts zu sichern hat, und die Meldung
   *   sagt genau das: die Löschung wurde überholt.
   *
   * Gated auf den Erstabgleich: solange der nicht durch ist, kennt dieses Gerät
   * den Datenbestand nur teilweise und dürfte gar nichts entscheiden.
   */
  async autoResolveConflicts(): Promise<void> {
    const store = this.store;
    if (!store || this.autoResolving || this.rotating) return;
    if (!this.initialPullSettled()) return;
    this.autoResolving = true;
    try {
      for (const id of await store.listConflicts()) {
        try {
          const c = await store.getConflict(id);
          if (!c) continue;
          const versions = [c.local, ...c.remotes];
          const branches = new Map<string, ConflictVersion>();
          for (const v of versions) branches.set(v.rev, v);
          const toBranch = async (v: ConflictVersion): Promise<ConflictBranch> => ({
            rev: v.rev,
            hash: await contentHash(v.bytes),
            // changedAt bevorzugt; Dokumente aus 1.2.x haben es nicht, dann
            // ersatzweise mtime (bei versteckten Dateien 0 — dann entscheidet
            // der Revisions-Tiebreaker).
            changedAt: v.meta.changedAt ?? v.meta.mtime ?? 0,
            deleted: v.deleted,
          });
          const winner = await toBranch(c.local);
          const others: ConflictBranch[] = [];
          for (const r of c.remotes) others.push(await toBranch(r));

          const plan = planAutoResolve(winner, others);
          if (!plan) continue;

          // Einmal nachschlagen, statt (wie zuvor) für Schreiben und Notice
          // getrennt — plan.keep steht für beide Zweige immer in branches,
          // siehe toBranch()/versions oben.
          const keep = branches.get(plan.keep);
          if (!keep) continue;
          const keepLabel = this.deviceLabel(keep.meta.device);

          // Gerät der Fassung, die als Sidecar gesichert wird. Bewusst
          // `contentLoser` und nicht `loser`: bei mehr als zwei Zweigen kann der
          // neueste Verlierer eine Löschung sein, gesichert wird dann aber der
          // neueste Verlierer MIT Inhalt — und dessen Gerät gehört in die Meldung.
          const contentLoserLabel =
            plan.kind === "newest-wins" && plan.contentLoser
              ? this.deviceLabel(branches.get(plan.contentLoser.rev)?.meta.device)
              : "";

          // Bei "newest-wins" MUSS die unterlegene Fassung sicher auf der Platte
          // liegen, BEVOR der Store sie verwirft — sonst ist sie bei einem
          // Schreibfehler unwiederbringlich weg (der Store hat den Zweig da schon
          // gelöscht). Deshalb: erst sichern, erst bei Erfolg auflösen. Schlägt die
          // Sicherung fehl, bleibt der Konflikt offen (sichere Richtung) und wird
          // beim nächsten Settle erneut versucht.
          //
          // Gesichert wird ausschließlich `contentLoser` — der neueste
          // unterlegene Zweig MIT Inhalt. Verliert nur eine Löschung, ist
          // `contentLoser` null: eine Löschung trägt keinen Inhalt, es steht
          // nichts auf dem Spiel, und eine leere Sicherungsdatei wäre bloßes
          // Rauschen.
          if (plan.kind === "newest-wins" && plan.contentLoser) {
            const contentLoser = branches.get(plan.contentLoser.rev);
            const saved = contentLoser
              ? await this.saveConflictSidecar(c.path, contentLoser.bytes)
              : false;
            if (!saved) {
              new Notice(
                `Vaultbridge: Konflikt bei „${c.path}" (${keepLabel} vs. ${contentLoserLabel}); ` +
                  `die unterlegene Fassung konnte nicht gesichert werden. Der Konflikt bleibt offen und wird ` +
                  `beim nächsten Abgleich erneut versucht.`,
                15000,
              );
              continue;
            }
          }

          // Welcher Store-Schritt nötig ist, entscheidet die reine Funktion —
          // die ist testbar, dieser Ausführungsteil wegen des obsidian-Imports
          // nicht.
          switch (planResolutionStep(plan.keep, c.local.rev, keep.deleted)) {
            case "prune":
              await store.pruneConflictRevs(c.id, plan.prune);
              break;
            case "write-deleted":
              await store.resolveConflictAsDeleted(c.id, c.path, keep.meta, plan.prune);
              break;
            default:
              await store.resolveConflict(c.id, c.path, keep.bytes, keep.meta, plan.prune);
              break;
          }

          if (plan.kind === "newest-wins") {
            if (keep.deleted) {
              // Die Löschung gewinnt: die Datei verschwindet überall, der
              // unterlegene Inhalt liegt als Sidecar daneben.
              new Notice(
                `Vaultbridge: „${c.path}" wurde auf ${keepLabel} gelöscht und auf ${contentLoserLabel} geändert. ` +
                  `Übernommen wurde die neuere Löschung; die Fassung von ${contentLoserLabel} liegt als ` +
                  `„${c.path}.vaultbridge-konflikt" im Vault.`,
                15000,
              );
            } else if (!plan.contentLoser) {
              // Nur eine Löschung ist unterlegen: nichts stand auf dem Spiel,
              // also auch kein Sidecar — nur die Erklärung, warum die
              // gelöschte Datei wieder da ist.
              const loeschendesGeraet = this.deviceLabel(branches.get(plan.loser.rev)?.meta.device);
              new Notice(
                `Vaultbridge: „${c.path}" wurde auf ${loeschendesGeraet} gelöscht und auf ${keepLabel} geändert. ` +
                  `Die neuere Änderung von ${keepLabel} hat die Löschung überholt — die Datei bleibt erhalten.`,
                15000,
              );
            } else {
              new Notice(
                `Vaultbridge: „${c.path}" wurde auf beiden Seiten geändert. Übernommen wurde die neuere Fassung ` +
                  `von ${keepLabel}; die Fassung von ${contentLoserLabel} liegt als „${c.path}.vaultbridge-konflikt" im Vault.`,
                15000,
              );
            }
          }
        } catch (e) {
          // Eine Datei darf den Durchlauf nicht abbrechen.
          new Notice(`Vaultbridge: Konflikt konnte nicht automatisch gelöst werden (${id}): ${String(e)}`);
        }
      }
    } finally {
      this.autoResolving = false;
    }
  }

  /** Anzeigename eines Geräts, mit Rückfallwert für Dokumente aus 1.2.x. */
  private deviceLabel(device: string | undefined): string {
    return device && device.length > 0 ? device : "einem unbekannten Gerät";
  }

  /**
   * Sichert eine unterlegene Fassung neben der Datei, damit nichts verloren geht.
   * Meldet per Rückgabewert, ob es geklappt hat — der Aufrufer braucht das, um dem
   * Nutzer nicht fälschlich eine erfolgreiche Sicherung zu melden, wenn sie fehlschlug.
   */
  private async saveConflictSidecar(path: string, bytes: Uint8Array): Promise<boolean> {
    try {
      await this.app.vault.adapter.writeBinary(`${path}.vaultbridge-konflikt`, bytes.slice().buffer);
      return true;
    } catch {
      return false;
    }
  }

  private async refreshConflicts(): Promise<void> {
    if (!this.store) {
      this.statusBar.setConflicts(0);
      return;
    }
    try {
      await this.autoResolveConflicts();
      const ids = await this.store.listConflicts();
      this.statusBar.setConflicts(ids.length);
      // Nur die LISTE (rechts) aktualisieren — der Diff-Bereich (Mitte) bleibt
      // bewusst stehen, damit ein Sync-Event die gerade offene Auflösung nicht
      // unter den Fingern zurücksetzt.
      this.renderConflictList();
      // Ist der offene Konflikt zwischenzeitlich verschwunden (extern gelöst),
      // den Diff einmal nachziehen, damit er nicht auf einer toten ID steht.
      if (this.activeConflictId && !ids.includes(this.activeConflictId)) {
        this.activeConflictId = ids[0] ?? null;
        this.renderConflictDiff();
      }
    } catch {
      /* Konfliktprüfung ist best-effort */
    }
  }

  private renderConflictList(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)) {
      if (leaf.view instanceof ConflictListView) void leaf.view.render();
    }
  }
  private renderConflictDiff(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICT_DIFF)) {
      if (leaf.view instanceof ConflictDiffView) void leaf.view.render();
    }
  }

  /**
   * Öffnet die Konfliktliste in der rechten Seitenleiste UND den Diff-Bereich im
   * Haupt-Editorbereich. Wählt den ersten Konflikt vor, damit sofort etwas zu
   * sehen ist.
   */
  async openConflictView(): Promise<void> {
    const { workspace } = this.app;
    // Liste rechts.
    let listLeaf = workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS)[0] ?? null;
    if (!listLeaf) {
      const right = workspace.getRightLeaf(false);
      if (right) { listLeaf = right; await listLeaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true }); }
    }
    // Ersten Konflikt vorwählen, wenn noch keiner offen ist.
    if (!this.activeConflictId && this.store) {
      const ids = await this.store.listConflicts();
      this.activeConflictId = ids[0] ?? null;
    }
    // Diff in der Mitte.
    let diffLeaf = workspace.getLeavesOfType(VIEW_TYPE_CONFLICT_DIFF)[0] ?? null;
    if (!diffLeaf) {
      diffLeaf = workspace.getLeaf("tab");
      await diffLeaf.setViewState({ type: VIEW_TYPE_CONFLICT_DIFF, active: true });
    }
    this.renderConflictList();
    this.renderConflictDiff();
    if (listLeaf) void workspace.revealLeaf(listLeaf);
    if (diffLeaf) void workspace.revealLeaf(diffLeaf);
  }

  /** Von der Liste (Klick): den gewählten Konflikt im Diff-Bereich öffnen. */
  async openConflictDiff(id: string): Promise<void> {
    this.activeConflictId = id;
    let diffLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICT_DIFF)[0] ?? null;
    if (!diffLeaf) {
      diffLeaf = this.app.workspace.getLeaf("tab");
      await diffLeaf.setViewState({ type: VIEW_TYPE_CONFLICT_DIFF, active: true });
    }
    this.renderConflictDiff();
    this.renderConflictList(); // Markierung des aktiven Eintrags
    void this.app.workspace.revealLeaf(diffLeaf);
  }

  /**
   * Fügt dem Rechtsklick-Menü eines Ordners/einer Datei im Dateibaum einen
   * kontextabhängigen Vaultbridge-Eintrag hinzu: je nach aktuellem Regel-Zustand
   * ausschließen, aufnehmen oder (bei ausgeschlossenem Elternordner) als Ausnahme
   * trotzdem synchronisieren. „forced"-Pfade (Vaultbridge-intern, oder versteckt
   * bei abgeschaltetem Hidden-Sync) bekommen keinen Eintrag.
   */
  private addSyncMenuItem(menu: Menu, file: TAbstractFile): void {
    const path = file.path;
    const state = syncRuleState(path, this.settings.rules, this.app.vault.configDir);
    if (state.reason === "forced") return;

    menu.addItem((item) => {
      if (state.synced) {
        item.setTitle("Von Vaultbridge-Sync ausschließen").setIcon("cloud-off");
        item.onClick(() => void this.setSyncInclusion(path, false));
      } else if (state.reason === "excluded-parent") {
        item.setTitle("Trotzdem mit Vaultbridge synchronisieren").setIcon("cloud");
        item.onClick(() => void this.setSyncInclusion(path, true));
      } else {
        item.setTitle("In Vaultbridge-Sync aufnehmen").setIcon("cloud");
        item.onClick(() => void this.setSyncInclusion(path, true));
      }
    });
  }

  /**
   * Setzt den Sync-Ein-/Ausschluss für einen Pfad, speichert die Regeln und
   * gleicht bei bestehender Verbindung sofort ab (updateRules). Ohne Verbindung
   * greift die Regel beim nächsten Verbinden.
   */
  private async setSyncInclusion(path: string, include: boolean): Promise<void> {
    this.settings.rules = setInclusion(path, include, this.settings.rules, this.app.vault.configDir);
    await this.saveSettings();
    if (this.bridge) {
      await this.bridge.updateRules(this.settings.rules);
      new Notice(include
        ? `Vaultbridge: „${path}" wird synchronisiert.`
        : `Vaultbridge: „${path}" vom Sync ausgeschlossen (bleibt lokal erhalten).`);
    } else {
      new Notice("Vaultbridge: Regel gespeichert — wirkt beim nächsten Verbinden.");
    }
  }

  /**
   * Manuelles Nachfassen für den Fall, dass jemand nicht auf den nächsten
   * Sync-Settle warten will. Nutzt exakt dieselbe Logik wie der Automatismus.
   */
  async resolveIdenticalConflicts(): Promise<void> {
    if (!this.store) { new Notice("Vaultbridge: nicht verbunden."); return; }
    if (!this.initialPullSettled()) {
      new Notice("Vaultbridge: Erstabgleich läuft noch — bitte kurz warten.");
      return;
    }
    const before = (await this.store.listConflicts()).length;
    await this.autoResolveConflicts();
    const after = (await this.store.listConflicts()).length;
    new Notice(
      `Vaultbridge: ${before - after} Konflikte gelöst` + (after > 0 ? `, ${after} verbleiben.` : "."),
      8000,
    );
    this.activeConflictId = null;
    await this.refreshConflicts();
    this.renderConflictDiff();
  }

  /** Von der Diff-View nach erfolgreicher Auflösung: nächsten Konflikt zeigen. */
  private async onConflictResolved(resolvedId: string): Promise<void> {
    if (this.activeConflictId === resolvedId) this.activeConflictId = null;
    if (this.store) {
      const ids = await this.store.listConflicts();
      this.activeConflictId = ids.find((i) => i !== resolvedId) ?? null;
    }
    await this.refreshConflicts();
    this.renderConflictDiff();
  }

  private async openHistory(path: string): Promise<void> {
    const store = this.store;
    const keys = this.keysForHistory;
    if (!store || !keys) { new Notice("Vaultbridge: nicht verbunden."); return; }
    const id = await pathId(keys.idKey, path);
    new HistoryModal(store, id, path, () => {}, this.app).open();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VaultbridgeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    // Regeln auf das aktuelle Schema migrieren (v1-Allowlist -> v2 "alles syncen").
    this.settings.rules = migrateRules(this.settings.rules);
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
