// Claude Code plugin discovery: read enabledPlugins from ~/.claude/settings.json
// and resolve each plugin's root directory.
//
// Resolution order:
//   1. <claudeDir>/plugins/marketplaces/<marketplace>/plugins/<name>/  (if it exists)
//   2. newest version dir under <claudeDir>/plugins/cache/<marketplace>/<name>/<version>/
//      (semver-ish descending; tolerates non-numeric segments like "unknown")

import * as path from "node:path";

import { dirExists, listDirNames, readJsonSafe } from "./fs-utils.ts";
import type { EnabledPlugin, ResolvedPlugin } from "./types.ts";

/** Parse an enabledPlugins key of the form "name@marketplace". */
export function parsePluginKey(key: string): EnabledPlugin | undefined {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** Extract enabled plugins from a parsed settings.json object. */
export function readEnabledPlugins(settings: unknown): EnabledPlugin[] {
  if (typeof settings !== "object" || settings === null) return [];
  const enabled = (settings as Record<string, unknown>)["enabledPlugins"];
  if (typeof enabled !== "object" || enabled === null) return [];

  const plugins: EnabledPlugin[] = [];
  for (const [key, value] of Object.entries(enabled as Record<string, unknown>)) {
    if (value !== true) continue;
    const parsed = parsePluginKey(key);
    if (parsed) plugins.push(parsed);
  }
  return plugins;
}

/**
 * Compare two version strings, semver-ish, descending (newest first).
 * Numeric segments compare numerically; non-numeric segments (e.g. "unknown")
 * rank below any numeric segment. Longer versions win ties ("1.2.1" > "1.2").
 */
export function compareVersionsDesc(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const rawA = as[i];
    const rawB = bs[i];
    const numA = rawA === undefined ? -2 : /^\d+$/.test(rawA) ? Number(rawA) : -1;
    const numB = rawB === undefined ? -2 : /^\d+$/.test(rawB) ? Number(rawB) : -1;
    if (numA !== numB) return numB - numA;
    if (numA === -1 && rawA !== undefined && rawB !== undefined && rawA !== rawB) {
      return rawB.localeCompare(rawA);
    }
  }
  return 0;
}

/** Pick the newest version from a list of version directory names. */
export function pickNewestVersion(versions: readonly string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersionsDesc)[0];
}

/** Filesystem access, injectable for tests. */
export interface PluginFs {
  dirExists(dirPath: string): boolean;
  listDirNames(dirPath: string): string[];
}

const realFs: PluginFs = {
  dirExists,
  listDirNames: (dir) => listDirNames(dir, "dir"),
};

/** Resolve a plugin's root directory, or undefined when not installed. */
export function resolvePluginRoot(
  claudeDir: string,
  plugin: EnabledPlugin,
  fsOps: PluginFs = realFs,
): string | undefined {
  const marketplaceRoot = path.join(
    claudeDir,
    "plugins",
    "marketplaces",
    plugin.marketplace,
    "plugins",
    plugin.name,
  );
  if (fsOps.dirExists(marketplaceRoot)) return marketplaceRoot;

  const cacheDir = path.join(claudeDir, "plugins", "cache", plugin.marketplace, plugin.name);
  if (!fsOps.dirExists(cacheDir)) return undefined;
  const newest = pickNewestVersion(fsOps.listDirNames(cacheDir));
  if (newest === undefined) return undefined;
  return path.join(cacheDir, newest);
}

/** Read settings.json and resolve every enabled plugin that exists on disk. */
export function resolveEnabledPlugins(
  claudeDir: string,
  fsOps: PluginFs = realFs,
): { plugins: ResolvedPlugin[]; missing: EnabledPlugin[] } {
  const settings = readJsonSafe(path.join(claudeDir, "settings.json"));
  const enabled = readEnabledPlugins(settings);

  const plugins: ResolvedPlugin[] = [];
  const missing: EnabledPlugin[] = [];
  for (const plugin of enabled) {
    const root = resolvePluginRoot(claudeDir, plugin, fsOps);
    if (root) {
      plugins.push({ ...plugin, root });
    } else {
      missing.push(plugin);
    }
  }
  return { plugins, missing };
}
