import { EventRef, Notice, Platform, Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { decodeSetup, encodeSetup } from "./setup/setupString";
import { deriveKeys, encryptBytes, decryptBytes, pathId, VaultKeys } from "./crypto/crypto";
import { base64urlToBytes, bytesToBase64url, utf8 } from "./crypto/encoding";
import { PouchDB } from "./store/pouch";
import { VaultStore } from "./store/store";
import { startSync, SyncHandle, SyncStatus } from "./store/replication";
import { EchoGuard } from "./vault/applyChange";
import { VaultBridge } from "./vault/bridge";
import { DEFAULT_RULES, SyncRules, migrateRules } from "./vault/rules";
import { promptPassphrase } from "./ui/PassphrasePromptModal";
import { ConflictListView, VIEW_TYPE_CONFLICTS } from "./ui/ConflictListView";
import { ConflictDiffView, VIEW_TYPE_CONFLICT_DIFF } from "./ui/ConflictDiffView";
import { ConflictSession } from "./conflicts/session";
import { SyncMode, shouldReplicateNow } from "./store/syncModes";
import { planPluginReload } from "./plugins/pluginSync";
import { GeneratorModal } from "./ui/GeneratorModal";
import { HistoryModal } from "./ui/HistoryModal";
import { makeVerifyToken, checkVerifyToken, needsAdoption } from "./crypto/rotation";

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
  // Aktuell im Diff-Bereich (ConflictDiffView) geöffneter Konflikt. Von der
  // Liste (rechts) gesetzt, von der Diff-View (Mitte) gelesen.
  private activeConflictId: string | null = null;
  // Als Feld (statt lokale Closure in connect()), damit restartSync() nach
  // einer Passphrase-Rotation denselben Status-Handler wiederverwenden kann.
  private readonly onSyncStatus = (s: SyncStatus, info?: string): void => {
    this.statusBar.setStatus(s, info);
    if (s === "idle" || s === "paused") {
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
      id: "resolve-identical-conflicts",
      name: "Identische Konflikte auflösen",
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
    this.disconnect(); // vorherige Verbindung sauber beenden (re-entrant-sicher)
    try {
      const payload = decodeSetup(this.settings.setupString);
      let passphrase = payload.passphrase ?? "";
      if (payload.pp === "separate") {
        passphrase = (await promptPassphrase(this.app, "Passphrase eingeben")) ?? "";
        if (!passphrase) { new Notice("Vaultbridge: keine Passphrase, abgebrochen."); return; }
      }
      const keys = await deriveKeys(passphrase, base64urlToBytes(payload.kdfSalt), payload.kdfIter);
      this.keysForHistory = keys;
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
        (m) => {
          this.settings.known = Object.fromEntries(m);
          if (this.knownSaveTimer !== null) window.clearTimeout(this.knownSaveTimer);
          this.knownSaveTimer = window.setTimeout(() => { this.knownSaveTimer = null; void this.saveSettings(); }, 2000);
        },
        (p) => this.onHiddenApplied(p),
      );
      this.bridge.start();

      const remoteUrl = `${payload.couchUrl.replace(/\/$/, "")}/${encodeURIComponent(payload.db)}`;
      const remote = new PouchDB(remoteUrl, { auth: { username: payload.user, password: payload.pass } });
      this.remote = remote;

      this.startSyncForMode();

      new Notice("Vaultbridge verbunden.");
      void this.refreshConflicts();
      void this.bridge.reconcileHidden();
      void this.checkAdoption();
    } catch (e) {
      this.disconnect();
      this.statusBar.setStatus("error", String(e));
      new Notice(`Vaultbridge: Verbindung fehlgeschlagen: ${String(e)}`);
    }
  }

  disconnect(): void {
    this.stopSyncStack();
    this.bridge = null;
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
    await new Promise<void>((resolve) => {
      startSync(this.localDb!, this.remote!, { live: false }, (s, info) => {
        this.statusBar.setStatus(s, info);
        if (s === "idle" || s === "error") resolve();
      });
    });
    await this.bridge?.reconcileFromStore();
    await this.bridge?.reconcileHidden();
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

  private async refreshConflicts(): Promise<void> {
    if (!this.store) {
      this.statusBar.setConflicts(0);
      return;
    }
    try {
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
   * Löst alle Konflikte auf, deren Versionen inhaltlich identisch sind (nur
   * divergierende CouchDB-Revisionen, kein echter Unterschied) — bei diesen geht
   * durch das Auflösen nichts verloren. Echte Konflikte (mit Unterschieden oder
   * mehreren Konfliktzweigen) bleiben unangetastet und müssen einzeln bearbeitet
   * werden.
   */
  async resolveIdenticalConflicts(): Promise<void> {
    if (!this.store) { new Notice("Vaultbridge: nicht verbunden."); return; }
    let resolved = 0;
    let remaining = 0;
    try {
      const ids = await this.store.listConflicts();
      for (const id of ids) {
        const c = await this.store.getConflict(id);
        if (!c) continue;
        const identical =
          !c.isBinary &&
          c.remotes.length === 1 &&
          new ConflictSession({
            id: c.id, path: c.path, isBinary: c.isBinary,
            local: { rev: c.local.rev, bytes: c.local.bytes },
            remote: { rev: c.remotes[0].rev, bytes: c.remotes[0].bytes },
          }).hunks.every((h) => h.kind === "equal");
        if (!identical) { remaining++; continue; }
        await this.store.resolveConflict(
          c.id, c.path, c.local.bytes, c.local.meta, c.remotes.map((r) => r.rev),
        );
        resolved++;
      }
      new Notice(
        `Vaultbridge: ${resolved} identische Konflikte gelöst` +
          (remaining > 0 ? `, ${remaining} echte verbleiben.` : "."),
        8000,
      );
    } catch (e) {
      new Notice(`Vaultbridge: Auflösen fehlgeschlagen: ${String(e)}`);
    }
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
