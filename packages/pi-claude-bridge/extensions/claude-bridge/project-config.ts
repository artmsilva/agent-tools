// Project-local persistence of the loaded/unloaded toggle.
// Forked from @entelligentsia/pi-claude-compat (MIT); renamed config dir.

import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DIR, CONFIG_FILE, GITIGNORE_ENTRY } from "./constants.ts";
import { readFileSafe } from "./fs-utils.ts";
import type { ProjectConfig } from "./types.ts";

/** Read the project-local config; null means "no override". */
export function readProjectConfig(cwd: string): ProjectConfig | null {
  const content = readFileSafe(path.join(cwd, CONFIG_DIR, CONFIG_FILE));
  if (content === null) return null;
  try {
    return JSON.parse(content) as ProjectConfig;
  } catch {
    return null;
  }
}

/** Write the project-local config; best-effort. */
export function writeProjectConfig(cwd: string, config: ProjectConfig): void {
  const dir = path.join(cwd, CONFIG_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
    return;
  }
  ensureGitignored(cwd);
}

function ensureGitignored(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // Missing -- created below.
  }

  const equivalents = new Set([
    GITIGNORE_ENTRY,
    GITIGNORE_ENTRY.replace(/\/$/, ""),
    "/" + GITIGNORE_ENTRY,
    "/" + GITIGNORE_ENTRY.replace(/\/$/, ""),
    ".pi/",
    ".pi",
    "/.pi/",
    "/.pi",
  ]);

  for (const line of existing.split(/\r?\n/)) {
    if (equivalents.has(line.trim())) return;
  }

  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  try {
    fs.writeFileSync(gitignorePath, existing + sep + GITIGNORE_ENTRY + "\n", "utf-8");
  } catch {
    // Best-effort.
  }
}
