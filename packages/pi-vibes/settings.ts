import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface VibesSettings {
  sound: boolean;
  mood: boolean;
  familiar: boolean;
}

const DEFAULT: VibesSettings = {
  sound: true,
  mood: true,
  familiar: true,
};

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "vibes.json");
}

export function loadSettings(): VibesSettings {
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(settingsPath(), "utf-8")) };
  } catch {
    return DEFAULT;
  }
}

export function saveSettings(settings: VibesSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}
