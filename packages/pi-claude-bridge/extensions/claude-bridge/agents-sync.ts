// Agent symlink sync: pi-subagents (npm:@tintinweb/pi-subagents) discovers
// agents from ~/.pi/agent/agents/*.md. There is no extension API to register
// agents dynamically, so the bridge maintains symlinks there for discovered
// user-scope and plugin agents.
//
// Safety contract:
//   - Only touch links recorded in our manifest (bridgeStatePath()).
//   - Never overwrite files/links we did not create (collision -> skip).
//   - Prune manifest-owned links whose source went away (idempotent).

import * as fs from "node:fs";
import * as path from "node:path";

import { fileExists, readJsonSafe } from "./fs-utils.ts";
import type { BridgeAgent } from "./types.ts";

interface BridgeStateFile {
  version?: number;
  /** link file name (e.g. "code-reviewer.md") -> symlink target */
  agentLinks?: Record<string, string>;
}

export interface AgentSyncResult {
  created: string[];
  updated: string[];
  pruned: string[];
  skipped: string[];
}

function readState(manifestPath: string): BridgeStateFile {
  const raw = readJsonSafe(manifestPath);
  if (typeof raw !== "object" || raw === null) return { version: 1, agentLinks: {} };
  const state = raw as BridgeStateFile;
  if (typeof state.agentLinks !== "object" || state.agentLinks === null) {
    state.agentLinks = {};
  }
  return state;
}

function writeState(manifestPath: string, state: BridgeStateFile): void {
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Best-effort; in-memory bookkeeping stays authoritative for this run.
  }
}

function lstatSafe(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Synchronize symlinks in `agentsDir` for the given agents.
 * First occurrence of a name wins (callers should order user before plugins).
 */
export function syncAgentLinks(
  agents: readonly BridgeAgent[],
  agentsDir: string,
  manifestPath: string,
): AgentSyncResult {
  const result: AgentSyncResult = { created: [], updated: [], pruned: [], skipped: [] };
  const state = readState(manifestPath);
  const managed = state.agentLinks ?? {};

  try {
    fs.mkdirSync(agentsDir, { recursive: true });
  } catch {
    return result;
  }

  const desired = new Map<string, string>();
  for (const agent of agents) {
    const linkName = `${agent.name}.md`;
    if (desired.has(linkName)) continue; // first wins
    if (!fileExists(agent.absolutePath)) continue;
    desired.set(linkName, agent.absolutePath);
  }

  // Create/refresh desired links.
  for (const [linkName, target] of desired) {
    const linkPath = path.join(agentsDir, linkName);
    const stat = lstatSafe(linkPath);

    if (stat === undefined) {
      try {
        fs.symlinkSync(target, linkPath);
        managed[linkName] = target;
        result.created.push(linkName);
      } catch {
        result.skipped.push(linkName);
      }
      continue;
    }

    if (!(linkName in managed)) {
      // Exists but not ours (user file, install.sh symlink, ...): never touch.
      result.skipped.push(linkName);
      continue;
    }

    if (stat.isSymbolicLink()) {
      let current: string | undefined;
      try {
        current = fs.readlinkSync(linkPath);
      } catch {
        current = undefined;
      }
      if (current !== target) {
        try {
          fs.unlinkSync(linkPath);
          fs.symlinkSync(target, linkPath);
          managed[linkName] = target;
          result.updated.push(linkName);
        } catch {
          result.skipped.push(linkName);
        }
      } else {
        managed[linkName] = target;
      }
    } else {
      // Manifest says ours, but on disk it's a regular file now: leave it alone.
      result.skipped.push(linkName);
      delete managed[linkName];
    }
  }

  // Prune manifest-owned links that are no longer desired.
  for (const linkName of Object.keys(managed)) {
    if (desired.has(linkName)) continue;
    const linkPath = path.join(agentsDir, linkName);
    const stat = lstatSafe(linkPath);
    if (stat?.isSymbolicLink()) {
      try {
        fs.unlinkSync(linkPath);
        result.pruned.push(linkName);
      } catch {
        // Leave the manifest entry so we retry next time.
        continue;
      }
    }
    delete managed[linkName];
  }

  writeState(manifestPath, { ...state, version: 1, agentLinks: managed });
  return result;
}
