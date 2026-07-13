/**
 * Build the guest VFS mount map and the host->guest path rewrites.
 *
 * Mounts:
 *   /workspace                     write-through RealFS of the host cwd
 *   <git common dir>               write-through RealFS of the shared .git for a
 *                                  linked worktree, at its real absolute path so
 *                                  the worktree's `gitdir:` pointer resolves
 *                                  (mirrors what `nono --allow $git_common_dir`
 *                                  does for the user's Claude sandbox)
 *   /root/.agents/skills           read-only RealFS of the global skills
 *   /root/.pi/agent/skills         read-only RealFS of pi's skills
 *   /gondolin/skel                 read-only RealFS of this package's guest skel
 *
 * Deliberately NOT mounted: the rest of $HOME. That would leak SSH keys, pi's
 * auth.json (API keys), 1Password material, and ~/.config/zsh/.secrets.env into
 * the guest. Dotfiles are delivered via the curated skel instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadonlyProvider, RealFSProvider, type VirtualProvider } from "@earendil-works/gondolin";
import { GUEST_HOME, GUEST_WORKSPACE } from "./paths.ts";

/** Guest mount point for the read-only dotfiles skeleton. */
export const GUEST_SKEL = "/gondolin/skel";

export interface MountPlan {
	mounts: Record<string, VirtualProvider>;
	/** Absolute host path of the shared git common dir for a linked worktree, if any. */
	worktreeCommonDir: string | undefined;
	/** Ordered [hostPath, guestPath] pairs for rewriting advertised paths (longest first). */
	rewrites: Array<[string, string]>;
	/** Host path of the packaged skel directory (source of truth for cp at boot). */
	skelHostDir: string;
	/** Human-readable list of what got mounted, for the /gondolin status command. */
	summary: string[];
}

function ro(hostDir: string): VirtualProvider {
	return new ReadonlyProvider(new RealFSProvider(realpathSync(hostDir)));
}

/** Detect the shared common .git dir when the cwd is a *linked* worktree. */
function detectWorktreeCommonDir(cwd: string): string | undefined {
	try {
		const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" }).trim();
		const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
		}).trim();
		const absGit = path.resolve(cwd, gitDir);
		const absCommon = path.resolve(cwd, commonDir);
		// Linked worktree iff the common dir differs from this worktree's git dir.
		if (absCommon && absCommon !== absGit && existsSync(absCommon)) return absCommon;
		return undefined;
	} catch {
		return undefined;
	}
}

export function buildMountPlan(localCwd: string): MountPlan {
	const home = homedir();
	const skelHostDir = fileURLToPath(new URL("../guest/skel", import.meta.url));

	const mounts: Record<string, VirtualProvider> = {
		[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
	};
	const summary: string[] = [`${localCwd} -> ${GUEST_WORKSPACE} (rw)`];
	const rewrites: Array<[string, string]> = [[localCwd, GUEST_WORKSPACE]];

	// Shared git common dir for linked worktrees, mounted at its real path.
	const worktreeCommonDir = detectWorktreeCommonDir(localCwd);
	if (worktreeCommonDir) {
		mounts[worktreeCommonDir] = new RealFSProvider(worktreeCommonDir);
		summary.push(`${worktreeCommonDir} -> ${worktreeCommonDir} (rw, shared .git)`);
	}

	// Read-only skills.
	const skillDirs: Array<[string, string]> = [
		[path.join(home, ".agents/skills"), path.posix.join(GUEST_HOME, ".agents/skills")],
		[path.join(home, ".pi/agent/skills"), path.posix.join(GUEST_HOME, ".pi/agent/skills")],
	];
	for (const [hostDir, guestDir] of skillDirs) {
		if (!existsSync(hostDir)) continue;
		mounts[guestDir] = ro(hostDir);
		summary.push(`${hostDir} -> ${guestDir} (ro)`);
	}

	// Dotfiles skeleton (curated; copied into /root at boot).
	if (existsSync(skelHostDir)) {
		mounts[GUEST_SKEL] = ro(skelHostDir);
		summary.push(`${skelHostDir} -> ${GUEST_SKEL} (ro, dotfiles skel)`);
	}

	// Path rewrites for advertised paths in the system prompt. Longest host path
	// first: cwd (and common dir) before the broad home->/root mapping.
	if (worktreeCommonDir) rewrites.push([worktreeCommonDir, worktreeCommonDir]);
	rewrites.push([home, GUEST_HOME]);
	rewrites.sort((a, b) => b[0].length - a[0].length);

	return { mounts, worktreeCommonDir, rewrites, skelHostDir, summary };
}

/** Apply the host->guest rewrites to a block of text (e.g. the system prompt). */
export function rewriteHostPaths(text: string, rewrites: Array<[string, string]>): string {
	let out = text;
	for (const [from, to] of rewrites) {
		if (from === to) continue;
		out = out.split(from).join(to);
	}
	return out;
}
