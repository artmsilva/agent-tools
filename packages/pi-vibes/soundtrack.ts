import { spawn } from "node:child_process";
import { platform } from "node:os";

/** System sounds for different events */
const SOUNDS: Record<string, string> = {
  longTool: "Glass",
  error: "Basso",
  needsInput: "Ping",
  settled: "Funk",
};

let lastPlayedAt = 0;
const DEBOUNCE_MS = 2000;

/** Play a macOS system sound (no-op on non-darwin) */
export function playSound(event: keyof typeof SOUNDS): void {
  if (platform() !== "darwin") return;

  const now = Date.now();
  if (now - lastPlayedAt < DEBOUNCE_MS) return;

  const sound = SOUNDS[event];
  if (!sound) return;

  const path = `/System/Library/Sounds/${sound}.aiff`;
  spawn("afplay", [path], { detached: true, stdio: "ignore" }).unref();
  lastPlayedAt = now;
}

/** Check if sound should play for a tool duration */
export function shouldPlayLongToolSound(durationMs: number): boolean {
  return durationMs > 10_000;
}
