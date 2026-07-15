import { describe, it, expect } from "vitest";
import { shouldReplicateNow } from "../src/store/syncModes";

describe("shouldReplicateNow", () => {
  it("continuous auf Desktop immer", () => {
    expect(shouldReplicateNow("continuous", { isMobile: false, onWifi: false, wifiOnly: false })).toBe(true);
  });
  it("manual nie automatisch", () => {
    expect(shouldReplicateNow("manual", { isMobile: true, onWifi: true, wifiOnly: false })).toBe(false);
  });
  it("WLAN-Gate blockt ohne WLAN auf Mobile", () => {
    expect(shouldReplicateNow("continuous", { isMobile: true, onWifi: false, wifiOnly: true })).toBe(false);
    expect(shouldReplicateNow("continuous", { isMobile: true, onWifi: true, wifiOnly: true })).toBe(true);
  });
  it("WLAN-Gate egal auf Desktop", () => {
    expect(shouldReplicateNow("continuous", { isMobile: false, onWifi: false, wifiOnly: true })).toBe(true);
  });
});
