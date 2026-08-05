import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { cleanupWorktrees, ensureWorktreeCwd } from "./worktree.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t: TestContext): { root: string; repo: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-worktree-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "test\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "initial"]);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, repo };
}

test("worktree reuse requires the expected path and branch in the same git record", async (t) => {
	const { root, repo } = repository(t);
	const teamDir = path.join(root, "team");
	const expectedPath = path.join(teamDir, "worktrees", "alice");
	const otherPath = path.join(root, "other");
	fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
	git(repo, ["worktree", "add", "-qb", "wrong-branch", expectedPath, "HEAD"]);
	git(repo, ["worktree", "add", "-qb", "pi-teams/team-1/alice", otherPath, "HEAD"]);

	await assert.rejects(
		ensureWorktreeCwd({ leaderCwd: repo, teamDir, teamId: "team-1", agentName: "alice" }),
		/Refusing to reuse unverified worktree/,
	);
});

test("cleanup preserves symlinked worktree entries instead of following them", async (t) => {
	const { root, repo } = repository(t);
	const teamDir = path.join(root, "team");
	const worktrees = path.join(teamDir, "worktrees");
	const external = path.join(root, "external");
	fs.mkdirSync(worktrees, { recursive: true });
	fs.mkdirSync(external);
	fs.writeFileSync(path.join(external, "keep.txt"), "keep\n");
	fs.symlinkSync(external, path.join(worktrees, "alice"));

	const result = await cleanupWorktrees({ teamDir, teamId: "team-1", repoCwd: repo });
	assert.equal(result.preservedWorktrees.length, 1);
	assert.equal(fs.readFileSync(path.join(external, "keep.txt"), "utf8"), "keep\n");
});
