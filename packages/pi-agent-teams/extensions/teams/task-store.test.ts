import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { claimTask, createTask, getTask, requeueTaskToPending } from "./task-store.js";

async function withTempTeamDir(fn: (teamDir: string) => Promise<void>): Promise<void> {
	const teamDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teams-task-store-test-"));
	try {
		await fn(teamDir);
	} finally {
		await fs.rm(teamDir, { recursive: true, force: true });
	}
}

test("concurrent claims produce exactly one winner", async () => {
	await withTempTeamDir(async (teamDir) => {
		const taskListId = "list-1";
		const created = await createTask(teamDir, taskListId, { subject: "Race", description: "..." });
		const claims = await Promise.all(
			["worker-a", "worker-b", "worker-c"].map((worker) => claimTask(teamDir, taskListId, created.id, worker)),
		);
		assert.equal(claims.filter(Boolean).length, 1);
		const task = await getTask(teamDir, taskListId, created.id);
		assert.equal(task?.owner, claims.find(Boolean)?.owner);
		assert.equal(task?.status, "in_progress");
	});
});

test("requeueTaskToPending resets an in_progress task to pending while keeping the owner", async () => {
	await withTempTeamDir(async (teamDir) => {
		const taskListId = "list-1";
		const created = await createTask(teamDir, taskListId, { subject: "Do the thing", description: "..." });
		const claimed = await claimTask(teamDir, taskListId, created.id, "worker-a");
		assert.ok(claimed);
		assert.equal(claimed?.status, "in_progress");

		const requeued = await requeueTaskToPending(teamDir, taskListId, created.id, "worker-a", "delivery failed");

		assert.ok(requeued);
		assert.equal(requeued?.status, "pending");
		assert.equal(requeued?.owner, "worker-a"); // not stranded in_progress, still owned so it can be retried
		assert.equal(requeued?.metadata?.requeuedReason, "delivery failed");

		const reread = await getTask(teamDir, taskListId, created.id);
		assert.equal(reread?.status, "pending");
		assert.equal(reread?.owner, "worker-a");
	});
});

test("requeueTaskToPending is a no-op when the task is owned by someone else", async () => {
	await withTempTeamDir(async (teamDir) => {
		const taskListId = "list-1";
		const created = await createTask(teamDir, taskListId, { subject: "Do the thing", description: "..." });
		await claimTask(teamDir, taskListId, created.id, "worker-a");

		const result = await requeueTaskToPending(teamDir, taskListId, created.id, "worker-b", "not mine");

		const reread = await getTask(teamDir, taskListId, created.id);
		assert.equal(result?.owner, "worker-a");
		assert.equal(result?.status, "in_progress");
		assert.equal(reread?.owner, "worker-a");
		assert.equal(reread?.status, "in_progress");
	});
});

test("requeueTaskToPending does not resurrect an already-completed task", async () => {
	await withTempTeamDir(async (teamDir) => {
		const taskListId = "list-1";
		const created = await createTask(teamDir, taskListId, { subject: "Do the thing", description: "..." });
		await claimTask(teamDir, taskListId, created.id, "worker-a");

		// Simulate completion happening concurrently before the requeue is applied.
		const { completeTask } = await import("./task-store.js");
		await completeTask(teamDir, taskListId, created.id, "worker-a", "done");

		const result = await requeueTaskToPending(teamDir, taskListId, created.id, "worker-a", "late failure");

		assert.equal(result?.status, "completed");
	});
});
