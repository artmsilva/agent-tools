// Wires Claude Code hooks onto pi extension events.
//
// See mapping.ts for the event table. All hook executions receive a
// Claude-schema JSON payload on stdin and run with CLAUDE_PLUGIN_ROOT /
// CLAUDE_PROJECT_DIR in the environment.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SESSION_END_TIMEOUT_CAP_MS } from "../constants.ts";
import type { CommandHookHandler, HookSource } from "./config.ts";
import {
  isMappedClaudeEvent,
  mapSessionEndReason,
  mapSessionStartSource,
  matcherMatches,
  piToolNameToClaude,
  toClaudeToolInput,
  toClaudeToolResponse,
  applyClaudeUpdatedInput,
} from "./mapping.ts";
import { parseHookJsonOutput, runCommandHook, type HookRunResult } from "./runner.ts";

const HOOK_MESSAGE_TYPE = "claude-bridge-hook";

/** Claude ends Stop-hook continuation loops after 8 consecutive blocks. */
const MAX_STOP_BLOCKS = 8;

export interface HookBridgeDeps {
  getSources(): HookSource[];
  isLoaded(): boolean;
  log(message: string): void;
}

export interface HookBridge {
  /** Run SessionStart hooks (called by index.ts after discovery completes). */
  runSessionStart(reason: string, ctx: ExtensionContext): Promise<void>;
  /** Run UserPromptSubmit hooks; returns context text to inject, if any. */
  runUserPromptSubmit(prompt: string, ctx: ExtensionContext): Promise<string | undefined>;
  /** Log unmappable Claude events found in the given sources (once per sync). */
  reportUnmappedEvents(sources: readonly HookSource[]): void;
}

interface MatchedHandler {
  source: HookSource;
  handler: CommandHookHandler;
}

interface PayloadContext {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

function payloadContext(ctx: ExtensionContext): PayloadContext {
  let transcript = "";
  let sessionId = "";
  try {
    const manager = ctx.sessionManager as unknown as {
      getSessionFile?: () => string | undefined;
      getSessionId?: () => string | undefined;
    };
    transcript = manager.getSessionFile?.() ?? "";
    sessionId = manager.getSessionId?.() ?? "";
  } catch {
    // Ephemeral or unavailable -- leave blank, matching "may be absent".
  }
  return { session_id: sessionId, transcript_path: transcript, cwd: ctx.cwd };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function hookSpecificOutput(json: Record<string, unknown> | undefined): Record<string, unknown> {
  const hso = json?.["hookSpecificOutput"];
  return typeof hso === "object" && hso !== null ? (hso as Record<string, unknown>) : {};
}

export function createHookBridge(pi: ExtensionAPI, deps: HookBridgeDeps): HookBridge {
  let stopBlockCount = 0;

  function collect(claudeEvent: string, matcherValue: string): MatchedHandler[] {
    const matched: MatchedHandler[] = [];
    for (const source of deps.getSources()) {
      const groups = source.config[claudeEvent];
      if (!groups) continue;
      for (const group of groups) {
        if (!matcherMatches(group.matcher, matcherValue)) continue;
        for (const handler of group.hooks) {
          matched.push({ source, handler });
        }
      }
    }
    return matched;
  }

  function envFor(source: HookSource, ctx: ExtensionContext): Record<string, string> {
    return {
      CLAUDE_PROJECT_DIR: ctx.cwd,
      ...(source.pluginRoot !== undefined ? { CLAUDE_PLUGIN_ROOT: source.pluginRoot } : {}),
    };
  }

  async function runOne(
    matched: MatchedHandler,
    payload: Record<string, unknown>,
    ctx: ExtensionContext,
    maxTimeoutMs?: number,
  ): Promise<HookRunResult> {
    const options = {
      cwd: ctx.cwd,
      env: envFor(matched.source, ctx),
      ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
    };
    if (matched.handler.async === true) {
      // Fire and forget; Claude's async hooks cannot block either.
      void runCommandHook(matched.handler, payload, options).then((result) => {
        if (result.exitCode !== 0) {
          deps.log(
            `${matched.source.label}: async hook exited ${String(result.exitCode)}: ${firstLine(result.stderr)}`,
          );
        }
      });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    const result = await runCommandHook(matched.handler, payload, options);
    if (result.timedOut) {
      deps.log(`${matched.source.label}: hook timed out (${payload["hook_event_name"] as string})`);
    } else if (result.error !== undefined) {
      deps.log(`${matched.source.label}: hook spawn failed: ${result.error}`);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // PreToolUse -> tool_call (blocking + input mutation)
  // -------------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (!deps.isLoaded()) return undefined;
    const claudeTool = piToolNameToClaude(event.toolName);
    const matched = collect("PreToolUse", claudeTool);
    if (matched.length === 0) return undefined;

    const input = event.input as Record<string, unknown>;
    for (const entry of matched) {
      const payload = {
        ...payloadContext(ctx),
        hook_event_name: "PreToolUse",
        tool_name: claudeTool,
        tool_input: toClaudeToolInput(event.toolName, input),
        tool_use_id: event.toolCallId,
      };
      const result = await runOne(entry, payload, ctx);

      if (result.exitCode === 2) {
        const reason = result.stderr.trim() || `Blocked by Claude hook (${entry.source.label})`;
        return { block: true, reason };
      }
      if (result.exitCode !== 0) {
        if (result.exitCode !== null) {
          deps.log(
            `${entry.source.label}: PreToolUse exited ${String(result.exitCode)}: ${firstLine(result.stderr)}`,
          );
        }
        continue;
      }

      const json = parseHookJsonOutput(result.stdout);
      if (json === undefined) continue;
      const hso = hookSpecificOutput(json);

      const decision = hso["permissionDecision"] ?? json["decision"];
      if (decision === "deny" || decision === "block") {
        const reason =
          (typeof hso["permissionDecisionReason"] === "string" && hso["permissionDecisionReason"]) ||
          (typeof json["reason"] === "string" && json["reason"]) ||
          `Blocked by Claude hook (${entry.source.label})`;
        return { block: true, reason };
      }
      if (json["continue"] === false) {
        const reason =
          (typeof json["stopReason"] === "string" && json["stopReason"]) ||
          `Stopped by Claude hook (${entry.source.label})`;
        return { block: true, reason };
      }

      const updatedInput = hso["updatedInput"];
      if (typeof updatedInput === "object" && updatedInput !== null) {
        applyClaudeUpdatedInput(event.toolName, input, updatedInput as Record<string, unknown>);
        deps.log(`${entry.source.label}: PreToolUse updatedInput applied to ${event.toolName}`);
      }
    }
    return undefined;
  });

  // -------------------------------------------------------------------------
  // PostToolUse -> tool_result (append feedback/context)
  // -------------------------------------------------------------------------
  pi.on("tool_result", async (event, ctx) => {
    if (!deps.isLoaded()) return undefined;
    const claudeTool = piToolNameToClaude(event.toolName);
    const matched = collect("PostToolUse", claudeTool);
    if (matched.length === 0) return undefined;

    const input = event.input as Record<string, unknown>;
    const resultText = textOfContent(event.content);
    const extraTexts: string[] = [];

    for (const entry of matched) {
      const payload = {
        ...payloadContext(ctx),
        hook_event_name: "PostToolUse",
        tool_name: claudeTool,
        tool_input: toClaudeToolInput(event.toolName, input),
        tool_response: toClaudeToolResponse(event.toolName, resultText, event.isError === true, input),
        tool_use_id: event.toolCallId,
      };
      const result = await runOne(entry, payload, ctx);

      if (result.exitCode === 2) {
        // Tool already ran; Claude shows stderr to the model.
        const reason = result.stderr.trim();
        if (reason) extraTexts.push(`[claude hook ${entry.source.label}] ${reason}`);
        continue;
      }
      if (result.exitCode !== 0) {
        if (result.exitCode !== null) {
          deps.log(
            `${entry.source.label}: PostToolUse exited ${String(result.exitCode)}: ${firstLine(result.stderr)}`,
          );
        }
        continue;
      }

      const json = parseHookJsonOutput(result.stdout);
      if (json === undefined) continue;
      const hso = hookSpecificOutput(json);

      if (json["decision"] === "block" && typeof json["reason"] === "string") {
        extraTexts.push(`[claude hook ${entry.source.label}] ${json["reason"]}`);
      }
      if (typeof hso["additionalContext"] === "string" && hso["additionalContext"].trim()) {
        extraTexts.push(hso["additionalContext"]);
      }
      if (hso["updatedToolOutput"] !== undefined) {
        deps.log(`${entry.source.label}: PostToolUse updatedToolOutput not supported -- skipped`);
      }
    }

    if (extraTexts.length === 0) return undefined;
    const content = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...content, { type: "text" as const, text: extraTexts.join("\n\n") }],
    };
  });

  // -------------------------------------------------------------------------
  // Stop -> agent_end (decision block => keep working via follow-up message)
  // -------------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    if (!deps.isLoaded()) return;
    const matched = collect("Stop", "");
    if (matched.length === 0) return;

    const messages = (event as { messages?: unknown[] }).messages ?? [];
    let lastAssistant = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: string; content?: unknown } | undefined;
      if (message?.role === "assistant") {
        lastAssistant = typeof message.content === "string" ? message.content : textOfContent(message.content);
        break;
      }
    }

    for (const entry of matched) {
      const payload = {
        ...payloadContext(ctx),
        hook_event_name: "Stop",
        stop_hook_active: stopBlockCount > 0,
        last_assistant_message: lastAssistant,
      };
      const result = await runOne(entry, payload, ctx);

      let blockReason: string | undefined;
      if (result.exitCode === 2) {
        blockReason = result.stderr.trim() || "Continue working (Claude Stop hook).";
      } else if (result.exitCode === 0) {
        const json = parseHookJsonOutput(result.stdout);
        if (json?.["decision"] === "block" && typeof json["reason"] === "string") {
          blockReason = json["reason"];
        }
      }

      if (blockReason !== undefined) {
        if (stopBlockCount >= MAX_STOP_BLOCKS) {
          deps.log(`${entry.source.label}: Stop hook block ignored (max ${MAX_STOP_BLOCKS} reached)`);
          continue;
        }
        stopBlockCount++;
        pi.sendMessage(
          {
            customType: HOOK_MESSAGE_TYPE,
            content: `Claude Stop hook (${entry.source.label}): ${blockReason}`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return; // one continuation at a time
      }
    }
  });

  // -------------------------------------------------------------------------
  // PreCompact -> session_before_compact (exit 2 / block => cancel)
  // -------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    if (!deps.isLoaded()) return undefined;
    const trigger = (event as { reason?: string }).reason === "manual" ? "manual" : "auto";
    const matched = collect("PreCompact", trigger);
    if (matched.length === 0) return undefined;

    for (const entry of matched) {
      const payload = {
        ...payloadContext(ctx),
        hook_event_name: "PreCompact",
        trigger,
        custom_instructions:
          typeof (event as { customInstructions?: unknown }).customInstructions === "string"
            ? ((event as { customInstructions?: string }).customInstructions as string)
            : "",
      };
      const result = await runOne(entry, payload, ctx);
      if (result.exitCode === 2) return { cancel: true };
      if (result.exitCode === 0) {
        const json = parseHookJsonOutput(result.stdout);
        if (json?.["decision"] === "block") return { cancel: true };
      }
    }
    return undefined;
  });

  // -------------------------------------------------------------------------
  // SessionEnd -> session_shutdown (capped timeout; no decision control)
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async (event, ctx) => {
    if (!deps.isLoaded()) return;
    const reason = mapSessionEndReason((event as { reason?: string }).reason ?? "quit");
    const matched = collect("SessionEnd", reason);
    for (const entry of matched) {
      const payload = {
        ...payloadContext(ctx),
        hook_event_name: "SessionEnd",
        reason,
      };
      await runOne(entry, payload, ctx, SESSION_END_TIMEOUT_CAP_MS);
    }
  });

  return {
    // -----------------------------------------------------------------------
    // SessionStart -> session_start (stdout/additionalContext => next-turn msg)
    // -----------------------------------------------------------------------
    async runSessionStart(reason: string, ctx: ExtensionContext): Promise<void> {
      if (!deps.isLoaded()) return;
      const source = mapSessionStartSource(reason);
      const matched = collect("SessionStart", source);
      if (matched.length === 0) return;

      const contexts: string[] = [];
      for (const entry of matched) {
        const payload = {
          ...payloadContext(ctx),
          hook_event_name: "SessionStart",
          source,
        };
        const result = await runOne(entry, payload, ctx);
        if (result.exitCode !== 0) {
          if (result.exitCode !== null && result.exitCode !== 0) {
            deps.log(
              `${entry.source.label}: SessionStart exited ${String(result.exitCode)}: ${firstLine(result.stderr)}`,
            );
          }
          continue;
        }
        const json = parseHookJsonOutput(result.stdout);
        if (json !== undefined) {
          const hso = hookSpecificOutput(json);
          if (typeof hso["additionalContext"] === "string" && hso["additionalContext"].trim()) {
            contexts.push(hso["additionalContext"]);
          }
        } else if (result.stdout.trim()) {
          // Plain stdout on SessionStart is added as context per Claude docs.
          contexts.push(result.stdout.trim());
        }
      }

      if (contexts.length > 0) {
        pi.sendMessage(
          {
            customType: HOOK_MESSAGE_TYPE,
            content: contexts.join("\n\n"),
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      }
    },

    // -----------------------------------------------------------------------
    // UserPromptSubmit -> before_agent_start (context injection only)
    // -----------------------------------------------------------------------
    async runUserPromptSubmit(prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
      stopBlockCount = 0;
      if (!deps.isLoaded()) return undefined;
      const matched = collect("UserPromptSubmit", "");
      if (matched.length === 0) return undefined;

      const contexts: string[] = [];
      for (const entry of matched) {
        const payload = {
          ...payloadContext(ctx),
          hook_event_name: "UserPromptSubmit",
          prompt,
        };
        const result = await runOne(entry, payload, ctx);
        if (result.exitCode === 2) {
          // pi's before_agent_start cannot reject the prompt; log-skip.
          deps.log(
            `${entry.source.label}: UserPromptSubmit block not supported in pi: ${firstLine(result.stderr)}`,
          );
          continue;
        }
        if (result.exitCode !== 0) continue;

        const json = parseHookJsonOutput(result.stdout);
        if (json !== undefined) {
          if (json["decision"] === "block") {
            deps.log(`${entry.source.label}: UserPromptSubmit block not supported in pi -- ignored`);
            continue;
          }
          const hso = hookSpecificOutput(json);
          if (typeof hso["additionalContext"] === "string" && hso["additionalContext"].trim()) {
            contexts.push(hso["additionalContext"]);
          }
        } else if (result.stdout.trim()) {
          contexts.push(result.stdout.trim());
        }
      }

      return contexts.length > 0 ? contexts.join("\n\n") : undefined;
    },

    reportUnmappedEvents(sources: readonly HookSource[]): void {
      for (const source of sources) {
        for (const eventName of Object.keys(source.config)) {
          if (!isMappedClaudeEvent(eventName)) {
            deps.log(`${source.label}: Claude event "${eventName}" has no pi equivalent -- skipped`);
          }
        }
        for (const skip of source.skipped) {
          deps.log(`${source.label}: ${skip}`);
        }
      }
    },
  };
}
