import { describe, expect, test } from "bun:test";

import {
  CLAUDE_TO_PI_EVENT,
  applyClaudeUpdatedInput,
  isMappedClaudeEvent,
  mapSessionEndReason,
  mapSessionStartSource,
  matcherMatches,
  piToolNameToClaude,
  toClaudeToolInput,
  toClaudeToolResponse,
} from "../extensions/claude-bridge/hooks/mapping.ts";

describe("event mapping", () => {
  test("maps supported events to pi equivalents", () => {
    expect(CLAUDE_TO_PI_EVENT["SessionStart"]).toBe("session_start");
    expect(CLAUDE_TO_PI_EVENT["SessionEnd"]).toBe("session_shutdown");
    expect(CLAUDE_TO_PI_EVENT["PreToolUse"]).toBe("tool_call");
    expect(CLAUDE_TO_PI_EVENT["PostToolUse"]).toBe("tool_result");
    expect(CLAUDE_TO_PI_EVENT["UserPromptSubmit"]).toBe("before_agent_start");
    expect(CLAUDE_TO_PI_EVENT["Stop"]).toBe("agent_end");
    expect(CLAUDE_TO_PI_EVENT["PreCompact"]).toBe("session_before_compact");
  });

  test("log-skips unmappable events", () => {
    expect(isMappedClaudeEvent("Notification")).toBe(false);
    expect(isMappedClaudeEvent("SubagentStop")).toBe(false);
    expect(isMappedClaudeEvent("PostToolBatch")).toBe(false);
    expect(isMappedClaudeEvent("PreCompact")).toBe(true);
  });

  test("session reason mapping", () => {
    expect(mapSessionStartSource("startup")).toBe("startup");
    expect(mapSessionStartSource("resume")).toBe("resume");
    expect(mapSessionStartSource("fork")).toBe("resume");
    expect(mapSessionStartSource("new")).toBe("clear");
    expect(mapSessionStartSource("reload")).toBe("startup");
    expect(mapSessionEndReason("quit")).toBe("other");
    expect(mapSessionEndReason("new")).toBe("clear");
    expect(mapSessionEndReason("resume")).toBe("resume");
  });
});

describe("matcherMatches", () => {
  test("wildcards", () => {
    expect(matcherMatches(undefined, "Bash")).toBe(true);
    expect(matcherMatches("", "Bash")).toBe(true);
    expect(matcherMatches("*", "Anything")).toBe(true);
  });

  test("exact and list matchers", () => {
    expect(matcherMatches("Bash", "Bash")).toBe(true);
    expect(matcherMatches("Bash", "Read")).toBe(false);
    expect(matcherMatches("Edit|Write|MultiEdit", "Write")).toBe(true);
    expect(matcherMatches("Edit, Write", "Edit")).toBe(true);
    expect(matcherMatches("code-reviewer", "code-reviewer")).toBe(true);
    expect(matcherMatches("code-reviewer", "senior-code-reviewer")).toBe(false);
  });

  test("regex matchers (unanchored)", () => {
    expect(matcherMatches("mcp__memory__.*", "mcp__memory__create_entities")).toBe(true);
    expect(matcherMatches("^Notebook", "NotebookEdit")).toBe(true);
    expect(matcherMatches("^Edit$", "NotebookEdit")).toBe(false);
    expect(matcherMatches("[invalid(", "anything")).toBe(false);
  });
});

describe("tool translation", () => {
  test("pi tool names -> Claude tool names", () => {
    expect(piToolNameToClaude("bash")).toBe("Bash");
    expect(piToolNameToClaude("edit")).toBe("Edit");
    expect(piToolNameToClaude("find")).toBe("Glob");
    expect(piToolNameToClaude("my_custom_tool")).toBe("my_custom_tool");
  });

  test("bash input: timeout seconds -> ms", () => {
    expect(toClaudeToolInput("bash", { command: "npm test", timeout: 30 })).toEqual({
      command: "npm test",
      timeout: 30_000,
    });
  });

  test("edit input: path/edits -> file_path/old_string/new_string", () => {
    expect(
      toClaudeToolInput("edit", {
        path: "/tmp/a.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      }),
    ).toEqual({ file_path: "/tmp/a.ts", old_string: "foo", new_string: "bar", replace_all: false });
  });

  test("read/write input: path -> file_path", () => {
    expect(toClaudeToolInput("read", { path: "/tmp/x", offset: 2 })).toEqual({
      file_path: "/tmp/x",
      offset: 2,
    });
    expect(toClaudeToolInput("write", { path: "/tmp/x", content: "hi" })).toEqual({
      file_path: "/tmp/x",
      content: "hi",
    });
  });

  test("unknown tools pass through", () => {
    const input = { foo: 1 };
    expect(toClaudeToolInput("weird", input)).toEqual({ foo: 1 });
  });

  test("updatedInput applies back onto pi input", () => {
    const bashInput: Record<string, unknown> = { command: "rm -rf /" };
    applyClaudeUpdatedInput("bash", bashInput, { command: "echo safe" });
    expect(bashInput["command"]).toBe("echo safe");

    const editInput: Record<string, unknown> = {
      path: "/tmp/a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    };
    applyClaudeUpdatedInput("edit", editInput, { old_string: "x", new_string: "y" });
    expect(editInput["edits"]).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("tool_response shapes", () => {
    expect(toClaudeToolResponse("bash", "out", false, {})).toEqual({
      stdout: "out",
      stderr: "",
      interrupted: false,
      isImage: false,
    });
    expect(toClaudeToolResponse("write", "", false, { path: "/tmp/x" })).toEqual({
      filePath: "/tmp/x",
      success: true,
    });
    expect(toClaudeToolResponse("grep", "hits", true, {})).toEqual({ content: "hits", isError: true });
  });
});
