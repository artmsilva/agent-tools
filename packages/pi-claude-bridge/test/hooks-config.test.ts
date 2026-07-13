import { describe, expect, test } from "bun:test";

import { parseHooksConfig } from "../extensions/claude-bridge/hooks/config.ts";

describe("parseHooksConfig", () => {
  test("parses the remember plugin's hooks.json shape", () => {
    const { config, skipped } = parseHooksConfig({
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-start-hook.sh"',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-hook.sh"',
            },
          ],
        },
      ],
    });

    expect(skipped).toEqual([]);
    expect(Object.keys(config)).toEqual(["SessionStart", "PostToolUse"]);
    expect(config["SessionStart"]?.[0]?.hooks[0]?.command).toContain("session-start-hook.sh");
    expect(config["SessionStart"]?.[0]?.matcher).toBeUndefined();
  });

  test("keeps matchers, timeouts, args, and async", () => {
    const { config } = parseHooksConfig({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "/usr/local/bin/dcg", timeout: 10 },
            { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/x.js"], async: true },
          ],
        },
      ],
    });

    const group = config["PreToolUse"]?.[0];
    expect(group?.matcher).toBe("Bash");
    expect(group?.hooks[0]).toEqual({ type: "command", command: "/usr/local/bin/dcg", timeout: 10 });
    expect(group?.hooks[1]?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/x.js"]);
    expect(group?.hooks[1]?.async).toBe(true);
  });

  test("skips non-command hook types with a log entry", () => {
    const { config, skipped } = parseHooksConfig({
      Stop: [
        {
          hooks: [
            { type: "prompt", prompt: "Evaluate: $ARGUMENTS" },
            { type: "command", command: "echo ok" },
          ],
        },
      ],
    });

    expect(config["Stop"]?.[0]?.hooks).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('unsupported hook type "prompt"');
  });

  test("drops empty/invalid structures", () => {
    expect(parseHooksConfig(null).config).toEqual({});
    expect(parseHooksConfig({ SessionStart: "nope" }).config).toEqual({});
    expect(parseHooksConfig({ SessionStart: [{ hooks: [] }] }).config).toEqual({});
    expect(parseHooksConfig({ SessionStart: [{ hooks: [{ type: "command" }] }] }).config).toEqual({});
  });
});
