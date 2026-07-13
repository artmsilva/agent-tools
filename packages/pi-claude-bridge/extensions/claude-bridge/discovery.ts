// Discovery of Claude commands, skills, and agents from a directory.
//
// Forked from @entelligentsia/pi-claude-compat (MIT) and generalized:
// commands carry absolute paths so a single registry can span project scope,
// user scope (~/.claude), and plugin roots.

import * as fs from "node:fs";
import * as path from "node:path";

import { dirExists, readFileSafe } from "./fs-utils.ts";
import type { BridgeAgent, BridgeCommand, BridgeSkill } from "./types.ts";

/**
 * Extract a description for a command/skill/agent from its markdown content.
 * Priority: frontmatter description > first heading > first content line > fallback.
 * (From pi-claude-compat.)
 */
export function extractDescription(content: string, fallbackName: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const frontmatter = fmMatch[1] ?? "";
    const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch?.[1]) {
      return descMatch[1].trim();
    }
  }

  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("<!--")) {
      return trimmed.length > 100 ? trimmed.slice(0, 100) + "..." : trimmed;
    }
  }

  return `Claude command: /${fallbackName}`;
}

/**
 * Recursively discover `.md` command files under `commandsDir`, following
 * Claude CLI naming: root files -> basename, nested -> segments joined by ":".
 * An optional `namePrefix` (e.g. a plugin name) is prepended with ":".
 */
export function discoverCommandsInDir(
  commandsDir: string,
  source: string,
  namePrefix = "",
): BridgeCommand[] {
  if (!dirExists(commandsDir)) return [];

  const commands: BridgeCommand[] = [];

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nestedPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        walk(path.join(dir, entry.name), nestedPrefix);
      } else if (entry.name.endsWith(".md")) {
        const baseName = entry.name.slice(0, -3);
        const localName = prefix ? `${prefix}:${baseName}` : baseName;
        const commandName = namePrefix ? `${namePrefix}:${localName}` : localName;
        const absolutePath = path.join(dir, entry.name);

        const content = readFileSafe(absolutePath);
        if (content === null) continue;

        commands.push({
          name: commandName,
          absolutePath,
          description: extractDescription(content, commandName),
          source,
        });
      }
    }
  }

  walk(commandsDir, "");
  return commands;
}

/**
 * Discover Agent Skills (directories containing SKILL.md) under `skillsDir`.
 */
export function discoverSkillsInDir(
  skillsDir: string,
  source: string,
  ignored?: ReadonlySet<string>,
): BridgeSkill[] {
  if (!dirExists(skillsDir)) return [];

  const skills: BridgeSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (ignored?.has(entry.name)) continue;

    const dirPath = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const content = readFileSafe(skillMdPath);
    if (content === null) continue;

    skills.push({
      name: entry.name,
      skillMdPath,
      dirPath,
      description: extractDescription(content, entry.name),
      source,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Discover agent definition files (`*.md`) directly under `agentsDir`.
 */
export function discoverAgentsInDir(agentsDir: string, source: string): BridgeAgent[] {
  if (!dirExists(agentsDir)) return [];

  const agents: BridgeAgent[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith(".md")) continue;
    agents.push({
      name: entry.name.slice(0, -3),
      absolutePath: path.join(agentsDir, entry.name),
      source,
    });
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}
