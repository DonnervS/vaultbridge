export type SyncMode = "continuous" | "interval" | "onOpenClose" | "manual";

export interface WifiContext {
  isMobile: boolean;
  onWifi: boolean;
  wifiOnly: boolean;
}

export function shouldReplicateNow(mode: SyncMode, ctx: WifiContext): boolean {
  if (mode === "manual") return false;
  if (ctx.isMobile && ctx.wifiOnly && !ctx.onWifi) return false;
  // continuous/interval/onOpenClose lösen an anderer Stelle das eigentliche Timing aus;
  // diese Funktion beantwortet nur "darf JETZT repliziert werden?".
  return true;
}
