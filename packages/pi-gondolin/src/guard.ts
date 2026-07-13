/**
 * Safety guards for commands and environment crossing the host/guest boundary.
 *
 * Two concerns:
 *
 *  1. git worktree corruption. `/workspace` is a write-through mount of the host
 *     cwd, and (for linked worktrees) the shared common `.git` dir is mounted at
 *     its real path. A `git gc` / `git worktree prune` run *inside* the guest sees
 *     the host's other worktree paths as non-existent and would prune them,
 *     corrupting live host worktrees. We refuse those subcommands. Auto-gc is also
 *     disabled at provision time (`gc.auto=0`).
 *
 *  2. HOME/identity leakage. pi forwards the host environment to the bash tool;
 *     left alone the guest inherits HOME=/Users/<you>, SSH_AUTH_SOCK, host PATH,
 *     etc. We strip host-scoped identity/location vars so the guest's own login
 *     shell and VM env win.
 */

/** Env var names that must never be inherited from the host into the guest. */
const STRIPPED_ENV_KEYS = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	"PATH",
	"MANPATH",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"NODE_OPTIONS",
	"npm_config_prefix",
	"NVM_DIR",
	"NVM_BIN",
	"BUN_INSTALL",
]);

/**
 * Sanitize an environment map before it is handed to the guest shell.
 *
 * Removes host identity/location vars and anything whose value references a host
 * home path (`/Users/...` or `/home/...`). The guest's VM-level env + login shell
 * supply HOME, PATH, etc.
 */
export function sanitizeGuestEnv(
	env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
	if (!env) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (STRIPPED_ENV_KEYS.has(key)) continue;
		if (/(^|:)\/Users\//.test(value) || /(^|:)\/home\//.test(value)) continue;
		result[key] = value;
	}
	return result;
}

/** Override env var: set to "1" to allow git gc/prune inside the guest anyway. */
export const GIT_GC_OVERRIDE_ENV = "GONDOLIN_ALLOW_GIT_GC";

/**
 * Refuse git commands that could prune/corrupt the shared host repo. Returns a
 * human-readable reason string when the command must be blocked, else null.
 */
export function gitSafetyViolation(command: string): string | null {
	if (process.env[GIT_GC_OVERRIDE_ENV] === "1") return null;
	const normalized = command.replace(/\s+/g, " ").trim();
	if (!/\bgit\b/.test(normalized)) return null;

	// Match the git *subcommand* position: `git` + optional global options
	// (-C <path>, -c <k=v>, --long[=v]) + the dangerous subcommand. Anchoring to
	// the subcommand avoids false positives like `git commit -m "gc"`.
	const GLOBAL = String.raw`(?:\s+(?:-c\s+\S+|-C\s+\S+|--[^\s]+))*`;
	const dangerous: Array<{ re: RegExp; what: string }> = [
		{ re: new RegExp(String.raw`\bgit\b${GLOBAL}\s+worktree\s+(?:prune|remove|move)\b`), what: "git worktree prune/remove/move" },
		{ re: new RegExp(String.raw`\bgit\b${GLOBAL}\s+gc\b`), what: "git gc" },
		{ re: new RegExp(String.raw`\bgit\b${GLOBAL}\s+prune\b`), what: "git prune" },
		{ re: new RegExp(String.raw`\bgit\b${GLOBAL}\s+reflog\s+expire\b`), what: "git reflog expire" },
		{ re: new RegExp(String.raw`\bgit\b${GLOBAL}\s+repack\b[^&|;]*\s-d\b`), what: "git repack -d" },
	];
	for (const { re, what } of dangerous) {
		if (re.test(normalized)) {
			return (
				`Refusing to run "${what}" inside the Gondolin sandbox: the host repo's ` +
				`worktree metadata is shared through the write-through mount, and pruning ` +
				`from the guest would corrupt live host worktrees. If you are certain this ` +
				`repo has no linked worktrees, re-run with ${GIT_GC_OVERRIDE_ENV}=1.`
			);
		}
	}
	return null;
}
