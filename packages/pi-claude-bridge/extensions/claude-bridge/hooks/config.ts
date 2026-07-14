// Parsing of Claude Code hooks configuration:
//   - plugin roots:            <root>/hooks/hooks.json  ({ description?, hooks: {...} })
//   - user settings:           ~/.claude/settings.json  ("hooks" key)
//
// Only `type: "command"` handlers are bridged; other types (prompt, agent,
// http, mcp_tool) are collected as skips for logging.

import * as path from "node:path";

import { readJsonSafe } from "../fs-utils.ts";
import type { ResolvedPlugin } from "../types.ts";

export interface CommandHookHandler {
  type: "command";
  command: string;
  args?: string[];
  /** Seconds, per Claude's schema. */
  timeout?: number;
  async?: boolean;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: CommandHookHandler[];
}

/** Claude event name -> matcher groups. */
export type HooksConfig = Record<string, HookMatcherGroup[]>;

export interface HookSource {
  /** Human-readable label, e.g. "plugin:remember" or "user-settings". */
  label: string;
  /** Plugin root (drives CLAUDE_PLUGIN_ROOT); undefined for settings hooks. */
  pluginRoot?: string;
  config: HooksConfig;
  /** Handler descriptions skipped during parsing (unsupported types). */
  skipped: string[];
}

export function parseHooksConfig(raw: unknown): { config: HooksConfig; skipped: string[] } {
  const config: HooksConfig = {};
  const skipped: string[] = [];
  if (typeof raw !== "object" || raw === null) return { config, skipped };

  for (const [eventName, groupsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) continue;
    const groups: HookMatcherGroup[] = [];

    for (const groupRaw of groupsRaw) {
      if (typeof groupRaw !== "object" || groupRaw === null) continue;
      const group = groupRaw as Record<string, unknown>;
      const handlersRaw = group["hooks"];
      if (!Array.isArray(handlersRaw)) continue;

      const handlers: CommandHookHandler[] = [];
      for (const handlerRaw of handlersRaw) {
        if (typeof handlerRaw !== "object" || handlerRaw === null) continue;
        const handler = handlerRaw as Record<string, unknown>;
        const type = handler["type"];
        if (type !== "command") {
          skipped.push(`${eventName}: unsupported hook type "${String(type)}"`);
          continue;
        }
        const command = handler["command"];
        if (typeof command !== "string" || command.trim() === "") {
          skipped.push(`${eventName}: command hook without command string`);
          continue;
        }
        const args = handler["args"];
        const timeout = handler["timeout"];
        handlers.push({
          type: "command",
          command,
          ...(Array.isArray(args) && args.every((a) => typeof a === "string")
            ? { args: args as string[] }
            : {}),
          ...(typeof timeout === "number" && timeout > 0 ? { timeout } : {}),
          ...(handler["async"] === true ? { async: true } : {}),
        });
      }

      if (handlers.length > 0) {
        const matcher = group["matcher"];
        groups.push({
          ...(typeof matcher === "string" ? { matcher } : {}),
          hooks: handlers,
        });
      }
    }

    if (groups.length > 0) config[eventName] = groups;
  }

  return { config, skipped };
}

/** Load a plugin's hooks/hooks.json as a HookSource (undefined when absent). */
export function loadPluginHooksSource(plugin: ResolvedPlugin): HookSource | undefined {
  const raw = readJsonSafe(path.join(plugin.root, "hooks", "hooks.json"));
  if (typeof raw !== "object" || raw === null) return undefined;
  const hooksRaw = (raw as Record<string, unknown>)["hooks"];
  const { config, skipped } = parseHooksConfig(hooksRaw);
  if (Object.keys(config).length === 0 && skipped.length === 0) return undefined;
  return { label: `plugin:${plugin.name}`, pluginRoot: plugin.root, config, skipped };
}

/** Load ~/.claude/settings.json "hooks" as a HookSource (undefined when absent). */
export function loadSettingsHooksSource(claudeDir: string): HookSource | undefined {
  const raw = readJsonSafe(path.join(claudeDir, "settings.json"));
  if (typeof raw !== "object" || raw === null) return undefined;
  const hooksRaw = (raw as Record<string, unknown>)["hooks"];
  if (typeof hooksRaw !== "object" || hooksRaw === null) return undefined;
  const { config, skipped } = parseHooksConfig(hooksRaw);
  if (Object.keys(config).length === 0 && skipped.length === 0) return undefined;
  return { label: "user-settings", config, skipped };
}
