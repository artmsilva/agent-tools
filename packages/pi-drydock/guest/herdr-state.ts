import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_PATH = "/run/pi-drydock/status/pi-state";
let failureReported = false;

type PiState = "idle" | "working";

export default function registerHerdrState(pi: ExtensionAPI): void {
  let interactive = false;

  pi.on("session_start", (_event, context) => {
    interactive = context.hasUI;
    writeState(interactive ? "idle" : "working");
  });
  pi.on("agent_start", () => writeState("working"));
  pi.on("agent_settled", (_event, context) => {
    if (interactive && context.isIdle()) writeState("idle");
    else if (!interactive) removeState();
  });
  pi.on("session_shutdown", () => removeState());
}

function writeState(state: PiState): void {
  const temporary = `${STATE_PATH}.${process.pid}`;
  try {
    writeFileSync(temporary, `${state}\n`, { mode: 0o600 });
    renameSync(temporary, STATE_PATH);
  } catch (error) {
    rmSync(temporary, { force: true });
    reportFailure(error);
  }
}

function removeState(): void {
  try {
    rmSync(STATE_PATH, { force: true });
  } catch (error) {
    reportFailure(error);
  }
}

function reportFailure(error: unknown): void {
  if (failureReported) return;
  failureReported = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pi-drydock:herdr] ${message}\n`);
}
