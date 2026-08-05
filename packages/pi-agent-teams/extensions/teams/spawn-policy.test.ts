import assert from "node:assert/strict";
import { test } from "node:test";
import { getDefaultWorkspaceMode, getMaxTeamWorkers, getTeamMemberStaleMs, isFreshOnlineMember } from "./spawn-policy.js";

test("team worker cap defaults to six and hard-clamps to eight", () => {
	assert.equal(getMaxTeamWorkers({}), 6);
	assert.equal(getMaxTeamWorkers({ PI_TEAMS_MAX_WORKERS: "4" }), 4);
	assert.equal(getMaxTeamWorkers({ PI_TEAMS_MAX_WORKERS: "99" }), 8);
	assert.equal(getMaxTeamWorkers({ PI_TEAMS_MAX_WORKERS: "nope" }), 6);
});

test("stale persisted workers do not consume capacity forever", () => {
	const now = Date.parse("2026-08-03T12:00:00.000Z");
	assert.equal(getTeamMemberStaleMs({}), 30_000);
	assert.equal(isFreshOnlineMember({ status: "online", lastSeenAt: "2026-08-03T11:59:50.000Z" }, now, 30_000), true);
	assert.equal(isFreshOnlineMember({ status: "online", lastSeenAt: "2026-08-03T11:58:00.000Z" }, now, 30_000), false);
	assert.equal(isFreshOnlineMember({ status: "offline", lastSeenAt: "2026-08-03T12:00:00.000Z" }, now, 30_000), false);
});

test("source-changing teammates default to worktrees", () => {
	assert.equal(getDefaultWorkspaceMode({}), "worktree");
	assert.equal(getDefaultWorkspaceMode({ PI_TEAMS_DEFAULT_WORKSPACE: "shared" }), "shared");
});
