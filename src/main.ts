import { Plugin } from "obsidian";
import { VaultbridgeSettingsTab } from "./ui/SettingsTab";

export interface VaultbridgeSettings {
  setupString: string;
  deviceName: string;
}

const DEFAULT_SETTINGS: VaultbridgeSettings = {
  setupString: "",
  deviceName: "",
};

export default class VaultbridgePlugin extends Plugin {
  settings: VaultbridgeSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultbridgeSettingsTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
