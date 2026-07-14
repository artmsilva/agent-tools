import * as os from "node:os";
import * as path from "node:path";

/** Session entry type used for persisted bridge state. */
export const STATE_ENTRY_TYPE = "claude-bridge:state";

/** Project-local persistence for the loaded/unloaded toggle. */
export const CONFIG_DIR = path.join(".pi", "pi-claude-bridge");
export const CONFIG_FILE = "config.json";
export const GITIGNORE_ENTRY = ".pi/pi-claude-bridge/";

/** Project-scope Claude commands directory (relative to cwd). */
export const PROJECT_COMMANDS_SUBDIR = path.join(".claude", "commands");

/** Project-scope Claude skills directory (relative to cwd). pi natively loads
 *  `.pi/skills` and `.agents/skills`, so we only contribute `.claude/skills`. */
export const PROJECT_SKILLS_SUBDIR = path.join(".claude", "skills");

/** Default per-hook timeout (task contract: 60s, not Claude's 600s). */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** Hard cap for SessionEnd hooks so pi shutdown is not held hostage. */
export const SESSION_END_TIMEOUT_CAP_MS = 5_000;

/** Claude Code user config directory. */
export function claudeUserDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** pi agent config directory. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Manifest tracking symlinks the bridge created (agents sync). */
export function bridgeStatePath(): string {
  return path.join(piAgentDir(), "pi-claude-bridge-state.json");
}
