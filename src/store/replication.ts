export type SyncStatus = "idle" | "active" | "paused" | "error";

export interface SyncHandle {
  stop(): void;
}

export function startSync(
  local: PouchDB.Database,
  remote: PouchDB.Database | string,
  opts: { live: boolean },
  onStatus: (status: SyncStatus, info?: string) => void,
): SyncHandle {
  const sync = local.sync(remote, {
    live: opts.live,
    retry: opts.live, // im Live-Modus mit Backoff erneut versuchen
  });

  // errText über einen unknown-Parameter: der Truthy-Check (err ? …) verengt err
  // sonst auf {} (Default-toString -> no-base-to-string). Verhalten identisch zu
  // String(err).
  const errText = (err: unknown): string => String(err);

  void sync
    .on("active", () => onStatus("active"))
    .on("paused", (err?: unknown) => onStatus(err ? "error" : "paused", err ? errText(err) : undefined))
    .on("change", () => onStatus("active"))
    .on("error", (err: unknown) => onStatus("error", errText(err)))
    .on("complete", () => onStatus("idle"));

  return {
    stop() {
      sync.cancel();
    },
  };
}
