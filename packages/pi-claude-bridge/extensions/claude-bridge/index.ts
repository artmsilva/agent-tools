// pi-claude-bridge -- make Claude Code user-scope content and plugins work in pi.
//
// Fork/supersession of @entelligentsia/pi-claude-compat (MIT, see NOTICE).
//
// Half 1 -- discovery:
//   project scope (kept from the compat layer):
//     .claude/commands/**/*.md        -> pi slash commands (nested dirs -> ":")
//     .claude/skills/*/SKILL.md       -> pi skills via resources_discover
//   user scope (new):
//     ~/.claude/commands/**/*.md      -> pi slash commands
//     ~/.claude/skills/*/SKILL.md     -> pi skills
//     ~/.claude/agents/*.md           -> agents (symlink-synced, see below)
//   plugins (new): ~/.claude/settings.json enabledPlugins -> plugin roots
//     (marketplaces dir preferred, else newest cache version):
//     <root>/commands, <root>/skills, <root>/agents
//   Agents are registered by symlinking into ~/.pi/agent/agents/ (consumed by
//   npm:@tintinweb/pi-subagents); links are tracked in a manifest and pruned
//   when stale. Files we did not create are never touched.
//
// Half 2 -- hooks bridge (hooks/*.ts): plugin hooks/hooks.json and
// ~/.claude/settings.json hooks run on mapped pi events.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

import { syncAgentLinks } from "./agents-sync.ts";
import { loadCommandContent } from "./command-content.ts";
import {
  PROJECT_COMMANDS_SUBDIR,
  PROJECT_SKILLS_SUBDIR,
  STATE_ENTRY_TYPE,
  bridgeStatePath,
  claudeUserDir,
  piAgentDir,
} from "./constants.ts";
import { discoverAgentsInDir, discoverCommandsInDir, discoverSkillsInDir } from "./discovery.ts";
import { listDirNames } from "./fs-utils.ts";
import { loadPluginHooksSource, loadSettingsHooksSource, type HookSource } from "./hooks/config.ts";
import { createHookBridge } from "./hooks/bridge.ts";
import { resolveEnabledPlugins } from "./plugins.ts";
import { readProjectConfig, writeProjectConfig } from "./project-config.ts";
import { buildSystemPromptSections } from "./system-prompt.ts";
import type { BridgeAgent, BridgeCommand, BridgeSkill, PersistedState, ResolvedPlugin } from "./types.ts";

const MAX_LOGS = 200;

export default function claudeBridgeExtension(pi: ExtensionAPI) {
  const registeredCommands = new Set<string>();
  /** Live registry consulted by command handlers (survives re-discovery). */
  const commandRegistry = new Map<string, BridgeCommand>();
  const collisions = new Map<string, string>();
  const logs: string[] = [];

  let loaded = true;
  let currentCommands: BridgeCommand[] = [];
  let currentSkills: BridgeSkill[] = [];
  let currentAgents: BridgeAgent[] = [];
  let plugins: ResolvedPlugin[] = [];
  let hookSources: HookSource[] = [];

  function log(message: string): void {
    logs.push(message);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    if (process.env.PI_CLAUDE_BRIDGE_DEBUG) {
      console.error(`[claude-bridge] ${message}`);
    }
  }

  const hookBridge = createHookBridge(pi, {
    getSources: () => hookSources,
    isLoaded: () => loaded,
    log,
  });

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Skill names pi already provides natively -- collision-skip these. */
  function nativeSkillNames(cwd: string): Set<string> {
    const names = new Set<string>();
    for (const dir of [
      path.join(piAgentDir(), "skills"),
      path.join(cwd, ".pi", "skills"),
      path.join(cwd, ".agents", "skills"),
    ]) {
      for (const name of listDirNames(dir)) names.add(name);
    }
    return names;
  }

  function discoverAll(cwd: string): void {
    const claudeDir = claudeUserDir();

    const resolution = resolveEnabledPlugins(claudeDir);
    plugins = resolution.plugins;
    for (const missing of resolution.missing) {
      log(`plugin ${missing.name}@${missing.marketplace} enabled but not found on disk`);
    }

    // --- Commands (project > user > plugins; plugin names prefixed on clash) ---
    const commandMap = new Map<string, BridgeCommand>();
    const addCommand = (cmd: BridgeCommand, pluginName?: string): void => {
      if (!commandMap.has(cmd.name)) {
        commandMap.set(cmd.name, cmd);
        return;
      }
      if (pluginName !== undefined) {
        const namespaced = `${pluginName}:${cmd.name}`;
        if (!commandMap.has(namespaced)) {
          commandMap.set(namespaced, { ...cmd, name: namespaced });
          return;
        }
      }
      log(`command /${cmd.name} from ${cmd.source} shadowed by ${commandMap.get(cmd.name)?.source ?? "?"}`);
    };

    for (const cmd of discoverCommandsInDir(path.join(cwd, PROJECT_COMMANDS_SUBDIR), "project")) {
      addCommand(cmd);
    }
    for (const cmd of discoverCommandsInDir(path.join(claudeDir, "commands"), "user")) {
      addCommand(cmd);
    }
    for (const plugin of plugins) {
      for (const cmd of discoverCommandsInDir(path.join(plugin.root, "commands"), `plugin:${plugin.name}`)) {
        addCommand(cmd, plugin.name);
      }
    }
    currentCommands = [...commandMap.values()];

    // --- Skills (project > user > plugins; skip pi-native names) ---
    const native = nativeSkillNames(cwd);
    const ignored = new Set(readProjectConfig(cwd)?.ignoredSkills ?? []);
    const skillMap = new Map<string, BridgeSkill>();
    const addSkill = (skill: BridgeSkill): void => {
      if (native.has(skill.name)) {
        log(`skill ${skill.name} (${skill.source}) already provided by pi -- skipped`);
        return;
      }
      if (skillMap.has(skill.name)) {
        log(`skill ${skill.name} (${skill.source}) shadowed by ${skillMap.get(skill.name)?.source ?? "?"}`);
        return;
      }
      skillMap.set(skill.name, skill);
    };

    for (const skill of discoverSkillsInDir(path.join(cwd, PROJECT_SKILLS_SUBDIR), "project", ignored)) {
      addSkill(skill);
    }
    for (const skill of discoverSkillsInDir(path.join(claudeDir, "skills"), "user", ignored)) {
      addSkill(skill);
    }
    for (const plugin of plugins) {
      addSkillDir(plugin, addSkill);
    }
    currentSkills = [...skillMap.values()];

    // --- Agents (user first, then plugins; sync handles on-disk collisions) ---
    const agents: BridgeAgent[] = [...discoverAgentsInDir(path.join(claudeDir, "agents"), "user")];
    for (const plugin of plugins) {
      agents.push(...discoverAgentsInDir(path.join(plugin.root, "agents"), `plugin:${plugin.name}`));
    }
    currentAgents = agents;

    // --- Hooks (user settings + each plugin's hooks/hooks.json) ---
    const sources: HookSource[] = [];
    const settingsSource = loadSettingsHooksSource(claudeDir);
    if (settingsSource) sources.push(settingsSource);
    for (const plugin of plugins) {
      const source = loadPluginHooksSource(plugin);
      if (source) sources.push(source);
    }
    hookSources = sources;
    hookBridge.reportUnmappedEvents(sources);
  }

  function addSkillDir(plugin: ResolvedPlugin, addSkill: (skill: BridgeSkill) => void): void {
    for (const skill of discoverSkillsInDir(path.join(plugin.root, "skills"), `plugin:${plugin.name}`)) {
      addSkill(skill);
    }
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  function registerDiscoveredCommand(cmd: BridgeCommand): void {
    pi.registerCommand(cmd.name, {
      description: `${cmd.description} (${cmd.source})`,
      handler: async (args, ctx) => {
        if (!loaded) {
          ctx.ui.notify(
            "claude-bridge is currently unloaded. Use /claude-load to restore commands and skills.",
            "warning",
          );
          return;
        }
        const current = commandRegistry.get(cmd.name);
        if (current === undefined) {
          ctx.ui.notify(
            `Command /${cmd.name} is not available in this context. Run /claude-commands to inspect.`,
            "error",
          );
          return;
        }
        const content = loadCommandContent(current.absolutePath, args);
        if (content === null) {
          ctx.ui.notify(`Command file not found: ${current.absolutePath}`, "error");
          return;
        }
        if (!content.trim()) {
          ctx.ui.notify(`Command file is empty: ${current.absolutePath}`, "warning");
          return;
        }
        pi.sendUserMessage(content);
      },
    });
    registeredCommands.add(cmd.name);
  }

  function syncResources(ctx: ExtensionContext): void {
    if (loaded) {
      discoverAll(ctx.cwd);
    } else {
      currentCommands = [];
      currentSkills = [];
      currentAgents = [];
      hookSources = [];
    }

    collisions.clear();
    commandRegistry.clear();

    const existingCommands = new Map<string, string>();
    for (const cmd of pi.getCommands()) {
      existingCommands.set(cmd.name, cmd.sourceInfo?.source ?? "unknown");
    }

    for (const cmd of currentCommands) {
      commandRegistry.set(cmd.name, cmd);
      if (registeredCommands.has(cmd.name)) continue;
      const existing = existingCommands.get(cmd.name);
      if (existing !== undefined) {
        collisions.set(cmd.name, existing);
        commandRegistry.delete(cmd.name);
        continue;
      }
      registerDiscoveredCommand(cmd);
    }

    // Agents: idempotent symlink sync into ~/.pi/agent/agents/.
    if (loaded) {
      const result = syncAgentLinks(currentAgents, path.join(piAgentDir(), "agents"), bridgeStatePath());
      for (const name of result.created) log(`agent link created: ${name}`);
      for (const name of result.updated) log(`agent link retargeted: ${name}`);
      for (const name of result.pruned) log(`agent link pruned: ${name}`);
      for (const name of result.skipped) log(`agent link skipped (not bridge-managed): ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------------

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY_TYPE, { loaded } satisfies PersistedState);
  }

  function reconstructState(ctx: ExtensionContext): void {
    loaded = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as PersistedState | undefined;
        if (data?.loaded !== undefined) loaded = data.loaded;
      }
    }
    const projectConfig = readProjectConfig(ctx.cwd);
    if (projectConfig?.loaded !== undefined) {
      loaded = projectConfig.loaded;
    }
    syncResources(ctx);
    persistState();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  pi.on("resources_discover", (event) => {
    if (!loaded) return undefined;
    // Discovery already ran on session_start; refresh in case cwd changed.
    discoverAll(event.cwd);
    const skillPaths = currentSkills.map((skill) => skill.skillMdPath);
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    reconstructState(ctx);
    const reason = (event as { reason?: string }).reason ?? "startup";
    await hookBridge.runSessionStart(reason, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!loaded) return undefined;

    const injected = await hookBridge.runUserPromptSubmit(event.prompt, ctx);
    const appended = buildSystemPromptSections(
      currentCommands.filter((cmd) => !collisions.has(cmd.name)),
      collisions,
    );

    if (injected === undefined && !appended) return undefined;
    return {
      ...(appended ? { systemPrompt: event.systemPrompt + "\n\n" + appended } : {}),
      ...(injected !== undefined
        ? { message: { customType: "claude-bridge-hook", content: injected, display: false } }
        : {}),
    };
  });

  // -------------------------------------------------------------------------
  // Management commands (kept from pi-claude-compat)
  // -------------------------------------------------------------------------

  pi.registerCommand("claude-unload", {
    description: "Unload all Claude Code commands, skills, and hooks from the current session",
    handler: async (_args, ctx) => {
      if (!loaded) {
        ctx.ui.notify("claude-bridge is already unloaded. Use /claude-load to restore.", "info");
        return;
      }
      const cmdCount = currentCommands.length;
      const skillCount = currentSkills.length;
      loaded = false;
      syncResources(ctx);
      writeProjectConfig(ctx.cwd, { loaded: false });
      persistState();
      ctx.ui.notify(
        `claude-bridge unloaded. ${cmdCount} commands, ${skillCount} skills, and all Claude hooks disabled. Use /claude-load to restore.`,
        "info",
      );
    },
  });

  pi.registerCommand("claude-load", {
    description: "Re-load Claude Code commands, skills, and hooks after an unload",
    handler: async (_args, ctx) => {
      if (loaded) {
        ctx.ui.notify("claude-bridge is already loaded. Use /claude-unload to toggle.", "info");
        return;
      }
      loaded = true;
      syncResources(ctx);
      writeProjectConfig(ctx.cwd, { loaded: true });
      persistState();
      ctx.ui.notify(
        `claude-bridge re-loaded. ${currentCommands.length} commands, ${currentSkills.length} skills, ${hookSources.length} hook sources active.`,
        "info",
      );
    },
  });

  pi.registerCommand("claude-commands", {
    description: "List Claude Code commands, skills, plugins, and hooks loaded by pi-claude-bridge",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      if (!loaded) {
        lines.push("Status: UNLOADED -- use /claude-load to restore.\n");
      }

      lines.push(`Plugins (${plugins.length}):`);
      for (const plugin of plugins) {
        lines.push(`  ${plugin.name}@${plugin.marketplace} -> ${plugin.root}`);
      }
      lines.push("");

      lines.push(`Commands (${currentCommands.length}):`);
      for (const cmd of currentCommands) {
        const collision = collisions.get(cmd.name);
        lines.push(`  /${cmd.name} [${cmd.source}]${collision ? ` (CONFLICT with ${collision})` : ""}`);
      }
      lines.push("");

      lines.push(`Skills (${currentSkills.length}):`);
      for (const skill of currentSkills) {
        lines.push(`  ${skill.name} [${skill.source}]`);
      }
      lines.push("");

      lines.push(`Agents (${currentAgents.length}):`);
      for (const agent of currentAgents) {
        lines.push(`  ${agent.name} [${agent.source}]`);
      }
      lines.push("");

      lines.push(`Hook sources (${hookSources.length}):`);
      for (const source of hookSources) {
        const events = Object.entries(source.config)
          .map(([event, groups]) => `${event}(${groups.reduce((n, g) => n + g.hooks.length, 0)})`)
          .join(", ");
        lines.push(`  ${source.label}: ${events || "none"}`);
      }

      if (logs.length > 0) {
        lines.push("");
        lines.push(`Recent log (${Math.min(logs.length, 20)} of ${logs.length}):`);
        for (const entry of logs.slice(-20)) {
          lines.push(`  ${entry}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
