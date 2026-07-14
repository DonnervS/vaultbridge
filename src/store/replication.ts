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

  sync
    .on("active", () => onStatus("active"))
    .on("paused", (err?: unknown) => onStatus(err ? "error" : "paused", err ? String(err) : undefined))
    .on("change", () => onStatus("active"))
    .on("error", (err: unknown) => onStatus("error", String(err)))
    .on("complete", () => onStatus("idle"));

  return {
    stop() {
      sync.cancel();
    },
  };
}
