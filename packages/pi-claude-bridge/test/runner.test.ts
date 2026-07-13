import { describe, expect, test } from "bun:test";

import {
  effectiveTimeoutMs,
  parseHookJsonOutput,
  runCommandHook,
  substitutePlaceholders,
} from "../extensions/claude-bridge/hooks/runner.ts";

describe("substitutePlaceholders", () => {
  test("replaces known vars and keeps unknown ones", () => {
    const vars = { CLAUDE_PLUGIN_ROOT: "/plug", CLAUDE_PROJECT_DIR: "/proj" };
    expect(substitutePlaceholders('bash "${CLAUDE_PLUGIN_ROOT}/x.sh"', vars)).toBe('bash "/plug/x.sh"');
    expect(substitutePlaceholders("${UNKNOWN_VAR}/y", vars)).toBe("${UNKNOWN_VAR}/y");
  });
});

describe("parseHookJsonOutput", () => {
  test("parses JSON objects only", () => {
    expect(parseHookJsonOutput('{"decision":"block","reason":"no"}')).toEqual({
      decision: "block",
      reason: "no",
    });
    expect(parseHookJsonOutput("  {\"ok\":true}\n")).toEqual({ ok: true });
    expect(parseHookJsonOutput("plain text")).toBeUndefined();
    expect(parseHookJsonOutput("[1,2]")).toBeUndefined();
    expect(parseHookJsonOutput("{broken")).toBeUndefined();
  });
});

describe("effectiveTimeoutMs", () => {
  test("defaults to 60s, respects per-hook seconds, honors caps", () => {
    expect(effectiveTimeoutMs({ type: "command", command: "x" })).toBe(60_000);
    expect(effectiveTimeoutMs({ type: "command", command: "x", timeout: 10 })).toBe(10_000);
    expect(effectiveTimeoutMs({ type: "command", command: "x", timeout: 10 }, 5_000)).toBe(5_000);
  });
});

describe("runCommandHook", () => {
  const opts = { cwd: process.cwd(), env: { CLAUDE_PROJECT_DIR: "/proj" } };

  test("shell form: stdin payload, env, exit 0 with JSON stdout", async () => {
    const result = await runCommandHook(
      {
        type: "command",
        command: 'input=$(cat); echo "{\\"got\\": $(echo "$input" | wc -c | tr -d " "), \\"proj\\": \\"$CLAUDE_PROJECT_DIR\\"}"',
      },
      { hook_event_name: "PreToolUse" },
      opts,
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const json = parseHookJsonOutput(result.stdout);
    expect(json?.["proj"]).toBe("/proj");
    expect(typeof json?.["got"]).toBe("number");
  });

  test("exit 2 with stderr (blocking semantics)", async () => {
    const result = await runCommandHook(
      { type: "command", command: 'echo "Blocked: nope" >&2; exit 2' },
      {},
      opts,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe("Blocked: nope");
  });

  test("exec form spawns command directly with args", async () => {
    const result = await runCommandHook(
      { type: "command", command: "echo", args: ["${CLAUDE_PROJECT_DIR}/ok"] },
      {},
      opts,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/proj/ok");
  });

  test("timeout kills the process", async () => {
    const result = await runCommandHook(
      { type: "command", command: "sleep 5" },
      {},
      { ...opts, maxTimeoutMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
