// Mapping between Claude Code hook events / tool schemas and pi extension events.
//
// Event mapping (Claude -> pi):
//   SessionStart     -> session_start
//   SessionEnd       -> session_shutdown
//   PreToolUse       -> tool_call          (exit 2 / deny => { block, reason })
//   PostToolUse      -> tool_result        (reason/additionalContext appended)
//   UserPromptSubmit -> before_agent_start (stdout/additionalContext injected)
//   Stop             -> agent_end          (decision block => follow-up message)
//   PreCompact       -> session_before_compact (exit 2 / block => cancel)
// Everything else (Notification, SubagentStop, PostToolBatch, ...) is log-skipped.

export const CLAUDE_TO_PI_EVENT: Readonly<Record<string, string>> = {
  SessionStart: "session_start",
  SessionEnd: "session_shutdown",
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  UserPromptSubmit: "before_agent_start",
  Stop: "agent_end",
  PreCompact: "session_before_compact",
};

export function isMappedClaudeEvent(eventName: string): boolean {
  return eventName in CLAUDE_TO_PI_EVENT;
}

/** pi built-in tool name -> Claude Code tool name (for matchers/payloads). */
const PI_TO_CLAUDE_TOOL: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

export function piToolNameToClaude(piToolName: string): string {
  return PI_TO_CLAUDE_TOOL[piToolName] ?? piToolName;
}

/**
 * Claude matcher semantics (docs: Hooks reference / Matcher patterns):
 *   - undefined, "" or "*"                      -> match all
 *   - only [A-Za-z0-9_- ,|] chars               -> exact string or |,-separated list
 *   - anything else                             -> unanchored JS regex
 */
export function matcherMatches(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .includes(value);
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

/** Map pi session_start reason -> Claude SessionStart source/matcher value. */
export function mapSessionStartSource(reason: string): "startup" | "resume" | "clear" | "compact" {
  switch (reason) {
    case "resume":
    case "fork":
      return "resume";
    case "new":
      return "clear";
    default:
      return "startup"; // "startup", "reload", unknown
  }
}

/** Map pi session_shutdown reason -> Claude SessionEnd reason/matcher value. */
export function mapSessionEndReason(reason: string): string {
  switch (reason) {
    case "new":
      return "clear";
    case "resume":
      return "resume";
    default:
      return "other"; // "quit", "reload", "fork", unknown
  }
}

/**
 * Translate a pi tool input object into Claude's tool_input schema, best-effort.
 * Unknown tools pass through unchanged.
 */
export function toClaudeToolInput(
  piToolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (piToolName) {
    case "bash":
      return {
        command: input["command"] ?? "",
        ...(typeof input["timeout"] === "number" ? { timeout: input["timeout"] * 1000 } : {}),
      };
    case "read":
      return {
        file_path: input["path"] ?? "",
        ...(input["offset"] !== undefined ? { offset: input["offset"] } : {}),
        ...(input["limit"] !== undefined ? { limit: input["limit"] } : {}),
      };
    case "write":
      return { file_path: input["path"] ?? "", content: input["content"] ?? "" };
    case "edit": {
      const edits = Array.isArray(input["edits"]) ? (input["edits"] as unknown[]) : [];
      const first =
        typeof edits[0] === "object" && edits[0] !== null
          ? (edits[0] as Record<string, unknown>)
          : {};
      return {
        file_path: input["path"] ?? "",
        old_string: first["oldText"] ?? "",
        new_string: first["newText"] ?? "",
        replace_all: false,
      };
    }
    case "grep":
      return {
        pattern: input["pattern"] ?? "",
        ...(input["path"] !== undefined ? { path: input["path"] } : {}),
        ...(input["glob"] !== undefined ? { glob: input["glob"] } : {}),
      };
    case "find":
      return {
        pattern: input["pattern"] ?? "",
        ...(input["path"] !== undefined ? { path: input["path"] } : {}),
      };
    default:
      return input;
  }
}

/**
 * Apply a PreToolUse `updatedInput` (Claude schema) back onto a pi tool input,
 * best-effort. Mutates `piInput` in place. Unknown tools get a direct merge.
 */
export function applyClaudeUpdatedInput(
  piToolName: string,
  piInput: Record<string, unknown>,
  updated: Record<string, unknown>,
): void {
  switch (piToolName) {
    case "bash":
      if (typeof updated["command"] === "string") piInput["command"] = updated["command"];
      if (typeof updated["timeout"] === "number") piInput["timeout"] = updated["timeout"] / 1000;
      return;
    case "read":
    case "write":
      if (typeof updated["file_path"] === "string") piInput["path"] = updated["file_path"];
      if (typeof updated["content"] === "string") piInput["content"] = updated["content"];
      if (typeof updated["offset"] === "number") piInput["offset"] = updated["offset"];
      if (typeof updated["limit"] === "number") piInput["limit"] = updated["limit"];
      return;
    case "edit": {
      if (typeof updated["file_path"] === "string") piInput["path"] = updated["file_path"];
      const edits = Array.isArray(piInput["edits"]) ? (piInput["edits"] as unknown[]) : [];
      const first =
        typeof edits[0] === "object" && edits[0] !== null
          ? (edits[0] as Record<string, unknown>)
          : undefined;
      if (first) {
        if (typeof updated["old_string"] === "string") first["oldText"] = updated["old_string"];
        if (typeof updated["new_string"] === "string") first["newText"] = updated["new_string"];
      }
      return;
    }
    default:
      Object.assign(piInput, updated);
  }
}

/**
 * Translate a pi tool result into Claude's tool_response shape, best-effort.
 */
export function toClaudeToolResponse(
  piToolName: string,
  text: string,
  isError: boolean,
  piInput: Record<string, unknown>,
): Record<string, unknown> {
  switch (piToolName) {
    case "bash":
      return { stdout: text, stderr: "", interrupted: false, isImage: false };
    case "write":
    case "edit":
      return { filePath: piInput["path"] ?? "", success: !isError };
    default:
      return { content: text, isError };
  }
}
