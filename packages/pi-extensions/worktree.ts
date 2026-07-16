/**
 * Worktree Extension
 *
 * Gives pi a first-class way to spin up an isolated git worktree with its
 * node_modules already in place — no `npm install` reinstall required.
 *
 * Exposes:
 *   - tool    `create_worktree`  (callable by the LLM)
 *   - command `/worktree <branch> [--symlink|--cow|--copy|--no-nm] [--base <ref>]`
 *
 * node_modules modes (source = the repo's main worktree):
 *   symlink : ln -s to the main worktree's node_modules (instant, 0 disk, but
 *             `npm install` in the worktree MUTATES the shared source install)
 *   cow     : APFS copy-on-write clone (instant, 0 disk until modified, isolated)
 *   copy    : plain recursive copy (isolated, slow)
 *   none    : skip; run `npm install` yourself
 *
 * Mirrors ~/.zsh/git-worktree.npm.plugin.zsh so the interactive `gwta` command
 * and pi behave identically.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type Mode = "symlink" | "cow" | "copy" | "none";

const WORKTREE_BASE = join(homedir(), "Github", ".worktrees");
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

interface RunResult {
	ok: boolean;
	path?: string;
	lines: string[];
	details: Record<string, unknown>;
}

// ── git / fs helpers ─────────────────────────────────────────────────────────

async function git(pi: ExtensionAPI, args: string[], cwd: string): Promise<ExecResult> {
	return pi.exec("git", args, { cwd });
}

async function gitOk(pi: ExtensionAPI, args: string[], cwd: string): Promise<boolean> {
	return (await git(pi, args, cwd)).code === 0;
}

async function repoName(pi: ExtensionAPI, cwd: string): Promise<string> {
	const remote = await git(pi, ["remote", "get-url", "origin"], cwd);
	if (remote.code === 0 && remote.stdout.trim()) {
		return basename(remote.stdout.trim()).replace(/\.git$/, "");
	}
	const top = await git(pi, ["rev-parse", "--show-toplevel"], cwd);
	return basename(top.stdout.trim() || cwd);
}

/** Path of the repo's main worktree (first entry of `git worktree list`). */
async function mainWorktree(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const res = await git(pi, ["worktree", "list", "--porcelain"], cwd);
	for (const line of res.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
	}
	return undefined;
}

/** node_modules dirs (relative to root) worth linking: root + workspace packages. */
function nodeModulesPaths(root: string): string[] {
	const out = new Set<string>();
	const hasNm = (rel: string) => existsSync(join(root, rel, "node_modules"));
	if (hasNm("")) out.add("node_modules");

	const globs: string[] = [];
	try {
		const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		let ws = pj.workspaces;
		if (ws && !Array.isArray(ws)) ws = ws.packages;
		if (Array.isArray(ws)) globs.push(...ws);
	} catch {
		/* no/invalid package.json */
	}
	try {
		const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
		for (const line of yaml.split(/\r?\n/)) {
			const m = line.match(/^\s*-\s*["']?([^"'#]+)["']?\s*$/);
			if (m) globs.push(m[1].trim());
		}
	} catch {
		/* no pnpm-workspace.yaml */
	}

	for (const g of globs) {
		if (!g || g.startsWith("!")) continue;
		const parts = g.split("/");
		if (parts[parts.length - 1] === "*") {
			const base = parts.slice(0, -1).join("/");
			let entries: import("node:fs").Dirent[] = [];
			try {
				entries = readdirSync(join(root, base), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				const rel = join(base, e.name);
				if (e.isDirectory() && hasNm(rel)) out.add(join(rel, "node_modules"));
			}
		} else if (hasNm(g)) {
			out.add(join(g, "node_modules"));
		}
	}
	return [...out];
}

async function linkOne(pi: ExtensionAPI, mode: Mode, src: string, dest: string): Promise<void> {
	if (existsSync(dest)) return; // never clobber
	mkdirSync(dirname(dest), { recursive: true });
	if (mode === "symlink") {
		symlinkSync(src, dest, "dir");
	} else if (mode === "cow") {
		// APFS clonefile; fall back to a plain copy off-APFS.
		const cow = await pi.exec("cp", ["-c", "-R", src, dest], { cwd: dirname(dest) });
		if (cow.code !== 0) cpSync(src, dest, { recursive: true });
	} else {
		cpSync(src, dest, { recursive: true });
	}
}

function lockDiverged(src: string, dest: string): string | undefined {
	for (const f of LOCKFILES) {
		const a = join(src, f);
		const b = join(dest, f);
		if (existsSync(a) && existsSync(b)) {
			try {
				if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) return f;
			} catch {
				/* unreadable — skip */
			}
		}
	}
	return undefined;
}

// ── core ─────────────────────────────────────────────────────────────────────

async function createWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { branch: string; mode: Mode; base?: string; path?: string; fetch?: boolean },
): Promise<RunResult> {
	const cwd = ctx.cwd;
	const lines: string[] = [];
	const details: Record<string, unknown> = { ...opts };

	if (!(await gitOk(pi, ["rev-parse", "--git-dir"], cwd))) {
		return { ok: false, lines: ["Not in a git repository"], details };
	}

	const branch = opts.branch.trim();
	if (!branch) return { ok: false, lines: ["A branch name is required"], details };

	const repo = await repoName(pi, cwd);
	const path = opts.path ?? join(WORKTREE_BASE, repo, branch.replace(/\//g, "-"));
	details.path = path;

	if (existsSync(path)) {
		return { ok: false, path, lines: [`Worktree path already exists: ${path}`], details };
	}
	mkdirSync(dirname(path), { recursive: true });

	// Optional fetch — auto when basing off a remote-tracking ref.
	const wantFetch = opts.fetch ?? opts.base?.includes("/") ?? false;
	if (wantFetch && opts.base) {
		const remote = opts.base.split("/")[0];
		lines.push(`Fetching ${remote}…`);
		await git(pi, ["fetch", remote], cwd);
	}

	// Create the worktree. Existing branch → check out; new branch → -b [base].
	const branchExists = await gitOk(pi, ["rev-parse", "--verify", branch], cwd);
	const addArgs = branchExists
		? ["worktree", "add", path, branch]
		: opts.base
			? ["worktree", "add", "-b", branch, path, opts.base]
			: ["worktree", "add", "-b", branch, path];
	const add = await git(pi, addArgs, cwd);

	// A non-zero exit is often just a post-checkout hook failing, not a failed
	// worktree. Trust the filesystem: if the worktree exists, keep going.
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			lines: [`Failed to create worktree`, add.stderr.trim() || add.stdout.trim()].filter(Boolean),
			details,
		};
	}
	lines.push(
		`Worktree created (${branchExists ? "existing" : "new"} branch): ${path}` +
			(add.code !== 0 ? `  [git hook exited ${add.code} — continued]` : ""),
	);

	// node_modules
	if (opts.mode === "none") {
		lines.push("node_modules: skipped (mode=none) → run `npm install` in the worktree");
		details.linked = 0;
		return { ok: true, path, lines, details };
	}

	const src = (await mainWorktree(pi, cwd)) ?? (await git(pi, ["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
	if (!src || !existsSync(join(src, "node_modules"))) {
		lines.push("node_modules: no source install in main worktree → run `npm install` in the worktree");
		details.linked = 0;
		return { ok: true, path, lines, details };
	}

	let linked = 0;
	for (const rel of nodeModulesPaths(src)) {
		try {
			await linkOne(pi, opts.mode, join(src, rel), join(path, rel));
			linked++;
		} catch (e) {
			lines.push(`  node_modules: failed to ${opts.mode} ${rel}: ${(e as Error).message}`);
		}
	}
	details.linked = linked;
	details.source = src;
	lines.push(`node_modules: ${opts.mode} × ${linked} dir(s) from ${src}`);

	const diverged = lockDiverged(src, path);
	if (diverged) {
		details.diverged = diverged;
		lines.push(`⚠️  ${diverged} differs from the source branch — linked deps may be stale.`);
		lines.push(
			opts.mode === "symlink"
				? "    A symlinked node_modules is SHARED: `npm install` here rewrites the source install. Prefer mode=cow."
				: "    Run `npm install` in the worktree to reconcile (safe — this copy is isolated).",
		);
	}

	return { ok: true, path, lines, details };
}

// ── registration ───────────────────────────────────────────────────────────

export default function worktreeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "create_worktree",
		label: "Create Worktree",
		description:
			"Create an isolated git worktree with node_modules already available (linked from the " +
			"main worktree) so you can build/test a branch without running `npm install`. Returns the " +
			"worktree path — cd there to work.",
		promptSnippet: "Spin up a git worktree with node_modules ready (symlink/CoW) — no npm install",
		promptGuidelines: [
			"Use create_worktree when you need to work on another branch in isolation without disturbing the current checkout or reinstalling dependencies.",
			"Prefer create_worktree mode=cow when the worktree may run `npm install` (isolated); mode=symlink shares node_modules with the main worktree and installs there would mutate it.",
		],
		parameters: Type.Object({
			branch: Type.String({ description: "Branch name (new or existing). Slashes become dashes in the path." }),
			mode: Type.Optional(
				StringEnum(["symlink", "cow", "copy", "none"], {
					description: "How to provision node_modules. Default: symlink (shared). cow = isolated APFS clone.",
				}),
			),
			base: Type.Optional(
				Type.String({ description: "Ref to base a NEW branch on, e.g. 'origin/main'. Auto-fetches when it contains a remote." }),
			),
			path: Type.Optional(Type.String({ description: "Explicit worktree path. Default: ~/Github/.worktrees/<repo>/<branch>." })),
			fetch: Type.Optional(Type.Boolean({ description: "Force a git fetch before creating (default: auto when base is remote-tracking)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const res = await createWorktree(pi, ctx, {
				branch: params.branch,
				mode: (params.mode as Mode) ?? "symlink",
				base: params.base,
				path: params.path,
				fetch: params.fetch,
			});
			return { content: [{ type: "text", text: res.lines.join("\n") }], details: res.details, isError: !res.ok };
		},
	});

	pi.registerCommand("worktree", {
		description: "Create a worktree with linked node_modules: /worktree <branch> [--symlink|--cow|--copy|--no-nm] [--base <ref>]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				ctx.ui.notify("Usage: /worktree <branch> [--symlink|--cow|--copy|--no-nm] [--base <ref>]", "warning");
				return;
			}
			let branch = "";
			let mode: Mode = "symlink";
			let base: string | undefined;
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				if (t === "--symlink") mode = "symlink";
				else if (t === "--cow") mode = "cow";
				else if (t === "--copy") mode = "copy";
				else if (t === "--no-nm") mode = "none";
				else if (t === "--base") base = tokens[++i];
				else if (!branch) branch = t;
			}
			const res = await createWorktree(pi, ctx, { branch, mode, base });
			ctx.ui.notify(res.lines.join("\n"), res.ok ? "info" : "error");
		},
	});
}
