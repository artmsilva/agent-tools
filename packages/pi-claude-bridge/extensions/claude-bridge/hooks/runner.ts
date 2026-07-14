// Command hook execution: spawn per Claude Code semantics.
//
//   - exec form  (args present):  spawn `command` directly with args
//   - shell form (args absent):   `bash -c "<command>"`
//   - env: CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR (+ ${...} placeholder substitution)
//   - JSON payload written to stdin
//   - default timeout 60s (per-handler `timeout` is seconds)
//   - exit 0: parse stdout JSON; exit 2: block with stderr; other: non-blocking error

import { spawn } from "node:child_process";

import { DEFAULT_HOOK_TIMEOUT_MS } from "../constants.ts";
import type { CommandHookHandler } from "./config.ts";

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn-level failure (e.g. binary not found). */
  error?: string;
}

export interface HookRunOptions {
  cwd: string;
  /** Extra env (CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR, ...). */
  env: Record<string, string>;
  /** Override the effective timeout ceiling in ms (e.g. SessionEnd cap). */
  maxTimeoutMs?: number;
}

/** Substitute ${VAR} placeholders that Claude expands in hook command strings. */
export function substitutePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
    return vars[name] ?? match;
  });
}

/** Parse hook stdout as a JSON object; undefined when not JSON. */
export function parseHookJsonOutput(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function effectiveTimeoutMs(handler: CommandHookHandler, maxTimeoutMs?: number): number {
  const requested = handler.timeout !== undefined ? handler.timeout * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
  return maxTimeoutMs !== undefined ? Math.min(requested, maxTimeoutMs) : requested;
}

/** Run a single command hook with the given JSON payload on stdin. */
export function runCommandHook(
  handler: CommandHookHandler,
  payload: Record<string, unknown>,
  options: HookRunOptions,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    const command = substitutePlaceholders(handler.command, options.env);
    const timeoutMs = effectiveTimeoutMs(handler, options.maxTimeoutMs);

    let child: ReturnType<typeof spawn>;
    try {
      if (handler.args !== undefined) {
        const args = handler.args.map((arg) => substitutePlaceholders(arg, options.env));
        child = spawn(command, args, { cwd: options.cwd, env });
      } else {
        child = spawn("bash", ["-c", command], { cwd: options.cwd, env });
      }
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead.
      }
    }, timeoutMs);

    const finish = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      finish({ exitCode: null, stdout, stderr, timedOut, error: error.message });
    });

    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut });
    });

    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // Hook may have exited before reading stdin (EPIPE) -- fine.
    }
  });
}
