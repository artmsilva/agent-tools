/** Mood state: green=ok, amber=retries/slow, red=errors, purple=long-running */
export type MoodColor = "green" | "amber" | "red" | "purple";

export interface ToolEvent {
  isError: boolean;
  durationMs: number;
}

/** Compute mood from rolling window of recent tool events */
export function computeMood(events: ToolEvent[], longRunningMs = 15_000): MoodColor {
  if (events.length === 0) return "green";

  const last2 = events.slice(-2);
  if (last2.length >= 2 && last2.every((e) => e.isError)) return "red";

  const slowCount = events.filter((e) => e.durationMs > 10_000).length;
  if (slowCount >= 2) return "amber";

  if (events.some((e) => e.isError)) return "amber";

  return "green";
}

/** Mood while a tool is running >15s */
export function longRunningMood(): MoodColor {
  return "purple";
}
