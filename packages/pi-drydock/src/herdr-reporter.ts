import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { DrydockControlPlane } from "./control-plane.ts";

const SOURCE = "drydock:pi";
const AGENT = "pi";
const STATE_PATH = "/run/pi-drydock/status/pi-state";
const READ_STATE = `test ! -L ${STATE_PATH} && test -f ${STATE_PATH} && head -c 16 ${STATE_PATH} || true`;
const VALID_STATES = new Set(["idle", "working"] as const);
const execFileAsync = promisify(execFile);

type PiState = "idle" | "working";

export interface HerdrContext {
  executable: string;
  paneId: string;
}

interface HerdrReporterOptions extends HerdrContext {
  control: DrydockControlPlane;
  drydock: string;
  pollIntervalMs: number;
  onError(error: Error): void;
}

export interface HerdrReporter {
  close(): Promise<void>;
}

export function herdrContextFromEnvironment(environment: NodeJS.ProcessEnv = process.env): HerdrContext | undefined {
  if (!isHerdrEnvironment(environment)) return undefined;
  const paneId = validPaneId(environment.HERDR_PANE_ID);
  if (!paneId) return undefined;
  return { executable: environment.HERDR_BIN_PATH || "herdr", paneId };
}

function isHerdrEnvironment(environment: NodeJS.ProcessEnv): boolean {
  if (environment.HERDR_ENV !== "1") return false;
  return Boolean(environment.HERDR_SOCKET_PATH);
}

function validPaneId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= 256 ? value : undefined;
}

export function startHerdrPiReporter(options: HerdrReporterOptions): HerdrReporter {
  const abort = new AbortController();
  let current: PiState | undefined;
  let disabled = false;
  let sequence = Date.now() * 1_000;

  const send = async (state?: PiState): Promise<boolean> => {
    const command = state ? "report-agent" : "release-agent";
    const args = [
      "pane",
      command,
      options.paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--seq",
      String(++sequence),
      ...(state ? ["--state", state] : []),
    ];
    try {
      await execFileAsync(options.executable, args);
      return true;
    } catch {
      return false;
    }
  };

  const report = async (state: PiState | undefined): Promise<void> => {
    if (state === current) return;
    if (!(await send(state))) throw new Error("Could not report Drydock Pi state to Herdr");
    current = state;
  };

  const loop = runReporterLoop(
    abort.signal,
    options.pollIntervalMs,
    async () => report(await readPiState(options.control, options.drydock)),
    (error) => {
      disabled = true;
      options.onError(error);
    },
  );

  return {
    async close() {
      abort.abort();
      await loop;
      if (!current) return;
      const delivered = await send();
      current = undefined;
      if (!delivered && !disabled) options.onError(new Error("Could not release Drydock Pi state in Herdr"));
    },
  };
}

async function runReporterLoop(
  signal: AbortSignal,
  pollIntervalMs: number,
  poll: () => Promise<void>,
  onError: (error: Error) => void,
): Promise<void> {
  try {
    while (!signal.aborted) {
      await poll();
      await delay(pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) onError(asError(error));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function readPiState(control: DrydockControlPlane, drydock: string): Promise<PiState | undefined> {
  const result = await control.exec(drydock, READ_STATE);
  if (result.exitCode !== 0) throw new Error(`Could not read Drydock Pi state: ${result.stderr.trim()}`);
  const state = result.stdout.trim();
  return VALID_STATES.has(state as PiState) ? state as PiState : undefined;
}
