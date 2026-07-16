import type { ExtensionAPI, ToolEvent as ToolExecEvent } from "@earendil-works/pi-coding-agent";
import { computeMood, longRunningMood, type MoodColor } from "./mood.ts";
import { familiarFrame, type FamiliarState } from "./familiar.ts";
import { playSound, shouldPlayLongToolSound } from "./soundtrack.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import type { ToolEvent } from "./mood.ts";

export default function (pi: ExtensionAPI) {
  let settings = loadSettings();
  const toolEvents: ToolEvent[] = [];
  const maxEvents = 10;

  let familiarState: FamiliarState = "idle";
  let tick = 0;
  let timer: NodeJS.Timeout | undefined;
  let longRunningTimer: NodeJS.Timeout | undefined;
  let toolStartTimes = new Map<string, number>();

  function updateStatus(ctx: { ui: { theme: { fg(color: string, text: string): string }; setStatus(key: string, text: string | undefined): void } }): void {
    if (!settings.mood && !settings.familiar) {
      ctx.ui.setStatus("vibes", undefined);
      return;
    }

    const parts: string[] = [];

    if (settings.mood) {
      const mood: MoodColor = longRunningTimer ? longRunningMood() : computeMood(toolEvents);
      const colorMap: Record<MoodColor, string> = { green: "success", amber: "warning", red: "error", purple: "accent" };
      parts.push(ctx.ui.theme.fg(colorMap[mood], "●"));
    }

    if (settings.familiar) {
      parts.push(familiarFrame(familiarState, tick));
    }

    ctx.ui.setStatus("vibes", parts.join(" "));
  }

  function startAnimation(ctx: Parameters<typeof updateStatus>[0]): void {
    if (timer) return;
    timer = setInterval(() => {
      tick++;
      updateStatus(ctx);
    }, 500);
    timer.unref();
  }

  function stopAnimation(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings();
    if (settings.familiar) startAnimation(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopAnimation();
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = undefined;
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    toolStartTimes.set(event.toolCallId, Date.now());
    familiarState = "running";
    updateStatus(ctx);

    if (longRunningTimer) clearTimeout(longRunningTimer);
    longRunningTimer = setTimeout(() => {
      updateStatus(ctx);
    }, 15_000);
    longRunningTimer.unref();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const start = toolStartTimes.get(event.toolCallId);
    toolStartTimes.delete(event.toolCallId);

    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = undefined;
    }

    if (start) {
      const durationMs = Date.now() - start;
      toolEvents.push({ isError: event.isError, durationMs });
      if (toolEvents.length > maxEvents) toolEvents.shift();

      if (settings.sound && shouldPlayLongToolSound(durationMs)) playSound("longTool");
      if (settings.sound && event.isError) playSound("error");
    }

    familiarState = event.isError ? "error" : "idle";
    updateStatus(ctx);
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (settings.sound) playSound("needsInput");
    familiarState = "idle";
    updateStatus(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && event.details && typeof event.details === "object") {
      const details = event.details as { stdout?: string; exitCode?: number };
      if (details.exitCode === 0 && /git\s+commit/.test(details.stdout || "")) {
        familiarState = "celebrate";
        updateStatus(ctx);
        setTimeout(() => {
          familiarState = "idle";
          updateStatus(ctx);
        }, 2000);
      }
    }
  });

  pi.registerCommand("vibes", {
    description: "Toggle vibes features: /vibes [sound|mood|familiar] [on|off]",
    handler: async (args, ctx) => {
      const [feature, state] = args.trim().toLowerCase().split(/\s+/);

      if (!feature) {
        const status = [
          `sound: ${settings.sound ? "on" : "off"}`,
          `mood: ${settings.mood ? "on" : "off"}`,
          `familiar: ${settings.familiar ? "on" : "off"}`,
        ].join(", ");
        ctx.ui.notify(`Vibes: ${status}`, "info");
        return;
      }

      if (!["sound", "mood", "familiar"].includes(feature)) {
        ctx.ui.notify("Usage: /vibes [sound|mood|familiar] [on|off]", "error");
        return;
      }

      const toggle = state === "on" ? true : state === "off" ? false : !settings[feature as keyof typeof settings];
      settings[feature as keyof typeof settings] = toggle;
      saveSettings(settings);

      if (feature === "familiar") {
        toggle ? startAnimation(ctx) : stopAnimation();
      }

      updateStatus(ctx);
      ctx.ui.notify(`${feature}: ${toggle ? "on" : "off"}`, "info");
    },
  });
}
