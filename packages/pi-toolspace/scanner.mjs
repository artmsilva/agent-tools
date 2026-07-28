import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function entries(path, predicate) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => predicate(entry, join(path, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function markdownNames(path) {
  return entries(path, (entry, entryPath) =>
    entry.name.endsWith(".md") && (entry.isFile() || (entry.isSymbolicLink() && existsSync(entryPath))),
  ).map((name) => name.slice(0, -3));
}

function skillNames(path) {
  return entries(path, (entry, entryPath) =>
    (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(entryPath, "SKILL.md")),
  );
}

function brokenLinks(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => {
      const target = join(path, name);
      try {
        return lstatSync(target).isSymbolicLink() && !existsSync(target);
      } catch {
        return false;
      }
    })
    .sort();
}

function serverNames(config) {
  return Object.keys(config.mcpServers ?? {}).sort();
}

function pluginState(settings, registry) {
  const installed = registry.plugins ?? registry;
  return Object.entries(settings.enabledPlugins ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => {
      const records = installed[name] ?? [];
      const latest = records.at(-1);
      return {
        name,
        version: latest?.version ?? "not installed",
        installed: Boolean(latest),
        path: latest?.installPath ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mcpSummary(name, config) {
  const server = config.mcpServers?.[name] ?? {};
  if (typeof server.url === "string") return { name, transport: "HTTP", target: new URL(server.url).host };
  if (typeof server.command === "string") return { name, transport: "stdio", target: basename(server.command) };
  return { name, transport: "configured", target: "" };
}

export function scanToolspace({ home = homedir() } = {}) {
  const paths = {
    piSettings: join(home, ".pi", "agent", "settings.json"),
    piMcp: join(home, ".pi", "agent", "mcp.json"),
    piSkills: join(home, ".pi", "agent", "skills"),
    piAgents: join(home, ".pi", "agent", "agents"),
    piPrompts: join(home, ".pi", "agent", "prompts"),
    piExtensions: join(home, ".pi", "agent", "extensions"),
    claudeSettings: join(home, ".claude", "settings.json"),
    claudeMcp: join(home, ".claude.json"),
    claudeProjectMcp: join(home, ".claude", ".mcp.json"),
    claudeSkills: join(home, ".claude", "skills"),
    claudeAgents: join(home, ".claude", "agents"),
    claudeCommands: join(home, ".claude", "commands"),
    claudePlugins: join(home, ".claude", "plugins", "installed_plugins.json"),
  };
  const piSettings = readJson(paths.piSettings);
  const piMcp = readJson(paths.piMcp);
  const claudeSettings = readJson(paths.claudeSettings);
  const claudeMcp = readJson(paths.claudeMcp);
  const claudeProjectMcp = readJson(paths.claudeProjectMcp);
  const pluginRegistry = readJson(paths.claudePlugins);
  const piMcpNames = serverNames(piMcp);
  const claudeMcpNames = serverNames(claudeMcp);
  const projectMcpNames = serverNames(claudeProjectMcp);
  const plugins = pluginState(claudeSettings, pluginRegistry);
  const broken = [
    ...brokenLinks(paths.piSkills).map((name) => `Pi skill: ${name}`),
    ...brokenLinks(paths.piAgents).map((name) => `Pi agent: ${name}`),
    ...brokenLinks(paths.piPrompts).map((name) => `Pi command: ${name}`),
  ];
  const missingPlugins = plugins.filter((plugin) => !plugin.installed).map((plugin) => `Enabled plugin not installed: ${plugin.name}`);

  return {
    generatedAt: new Date().toISOString(),
    paths,
    pi: {
      model: piSettings.defaultModel ?? "not configured",
      provider: piSettings.defaultProvider ?? "not configured",
      theme: piSettings.theme ?? "not configured",
      packages: piSettings.packages?.length ?? 0,
      resources: {
        skills: skillNames(paths.piSkills),
        agents: markdownNames(paths.piAgents),
        commands: markdownNames(paths.piPrompts),
        extensions: entries(paths.piExtensions, (entry, entryPath) =>
          entry.name.endsWith(".ts") && (entry.isFile() || (entry.isSymbolicLink() && existsSync(entryPath))),
        ),
      },
      mcp: piMcpNames.map((name) => mcpSummary(name, piMcp)),
      imports: piMcp.imports ?? [],
    },
    claude: {
      model: claudeSettings.model ?? "configured by Claude Code",
      theme: claudeSettings.theme ?? "not configured",
      resources: {
        skills: skillNames(paths.claudeSkills),
        agents: markdownNames(paths.claudeAgents),
        commands: markdownNames(paths.claudeCommands),
      },
      plugins,
      mcp: claudeMcpNames.map((name) => mcpSummary(name, claudeMcp)),
      projectMcp: projectMcpNames.map((name) => mcpSummary(name, claudeProjectMcp)),
      hooks: Object.keys(claudeSettings.hooks ?? {}).sort(),
    },
    shared: {
      mcpOverrides: piMcpNames.filter((name) => claudeMcpNames.includes(name)),
      bridge: piSettings.packages?.some((entry) => String(entry).includes("pi-claude-bridge")) ?? false,
    },
    health: [...broken, ...missingPlugins],
  };
}
