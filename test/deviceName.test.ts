import { describe, it, expect } from "vitest";
import { defaultDeviceName, randomDeviceSuffix } from "../src/setup/deviceName";

const NONE = { isMacOS: false, isWin: false, isIosApp: false, isAndroidApp: false, isTablet: false };

describe("defaultDeviceName", () => {
  it("erkennt macOS", () => {
    expect(defaultDeviceName({ ...NONE, isMacOS: true }, "7f3")).toBe("Mac-7f3");
  });

  it("erkennt Windows", () => {
    expect(defaultDeviceName({ ...NONE, isWin: true }, "a12")).toBe("Windows-a12");
  });

  it("unterscheidet iPhone und iPad", () => {
    expect(defaultDeviceName({ ...NONE, isIosApp: true }, "4c8")).toBe("iPhone-4c8");
    expect(defaultDeviceName({ ...NONE, isIosApp: true, isTablet: true }, "4c8")).toBe("iPad-4c8");
  });

  it("erkennt Android", () => {
    expect(defaultDeviceName({ ...NONE, isAndroidApp: true }, "9d1")).toBe("Android-9d1");
  });

  it("fällt auf Linux zurück, wenn keine Plattform passt", () => {
    expect(defaultDeviceName(NONE, "b04")).toBe("Linux-b04");
  });

  it("bevorzugt die Mobil-Plattform, wenn beide Flags gesetzt sind", () => {
    // Auf iOS meldet Obsidian teils zusätzlich isMacOS — das Gerät ist trotzdem ein iPhone.
    expect(defaultDeviceName({ ...NONE, isMacOS: true, isIosApp: true }, "111")).toBe("iPhone-111");
  });
});

describe("randomDeviceSuffix", () => {
  it("liefert drei Hex-Zeichen", () => {
    expect(randomDeviceSuffix()).toMatch(/^[0-9a-f]{3}$/);
  });

  it("liefert bei wiederholtem Aufruf nicht immer dasselbe", () => {
    const seen = new Set(Array.from({ length: 40 }, () => randomDeviceSuffix()));
    expect(seen.size).toBeGreaterThan(1);
  });
});
