import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	computeTaskFinalizeOutcome,
	deliverAssignedTaskPrompt,
	deliverAutoClaimedTaskPrompt,
	deliverQueuedDmText,
	getCompactThresholdPercent,
	loadWorkerSystemPrompt,
	planIdleNotifications,
	sendPlanApprovedMessage,
	sendPlanRejectedMessage,
	sendUrgentDmMessage,
	shouldCompactBeforeNextTask,
	trySendUserMessage,
} from "./worker.js";

test("worker system prompts load only from bounded team artifacts", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-prompt-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const teamDir = path.join(root, "team");
	const prompt = path.join(teamDir, "prompts", "worker.md");
	const outside = path.join(root, "outside.md");
	fs.mkdirSync(path.dirname(prompt), { recursive: true });
	fs.writeFileSync(prompt, "specialist prompt\n");
	fs.writeFileSync(outside, "outside\n");
	assert.equal(loadWorkerSystemPrompt(teamDir, prompt), "specialist prompt");
	assert.equal(loadWorkerSystemPrompt(teamDir, outside), "");
});

// --- deliverAs: followUp for non-urgent sends, steer only for urgent DMs ---

test("sendPlanApprovedMessage delivers as followUp, never steer", () => {
	const calls: Array<[unknown, unknown]> = [];
	sendPlanApprovedMessage((content, options) => calls.push([content, options]));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.[1], { deliverAs: "followUp" });
});

test("sendPlanRejectedMessage delivers as followUp and includes feedback", () => {
	const calls: Array<[unknown, unknown]> = [];
	sendPlanRejectedMessage((content, options) => calls.push([content, options]), "needs more detail");
	assert.equal(calls.length, 1);
	assert.match(String(calls[0]?.[0]), /needs more detail/);
	assert.deepEqual(calls[0]?.[1], { deliverAs: "followUp" });
});

test("sendUrgentDmMessage delivers as steer (urgent mailbox messages keep steering)", () => {
	const calls: Array<[unknown, unknown]> = [];
	sendUrgentDmMessage((content, options) => calls.push([content, options]), "ada", "drop everything");
	assert.equal(calls.length, 1);
	assert.match(String(calls[0]?.[0]), /ada/);
	assert.match(String(calls[0]?.[0]), /drop everything/);
	assert.deepEqual(calls[0]?.[1], { deliverAs: "steer" });
});

test("trySendUserMessage returns true when the send succeeds", () => {
	const ok = trySendUserMessage(() => {}, "hi", { deliverAs: "followUp" });
	assert.equal(ok, true);
});

test("trySendUserMessage returns false (never throws) when the send throws", () => {
	const ok = trySendUserMessage(() => {
		throw new Error("boom");
	}, "hi");
	assert.equal(ok, false);
});

// --- assigned-task prompt: followUp delivery, requeue-to-pending on failure ---

test("deliverAssignedTaskPrompt delivers as followUp and does not requeue on success", async () => {
	const calls: Array<[unknown, unknown]> = [];
	let requeueCalls = 0;
	const delivered = await deliverAssignedTaskPrompt(
		{
			sendUserMessage: (content, options) => calls.push([content, options]),
			requeueTaskToPending: async () => {
				requeueCalls += 1;
			},
		},
		"do the thing",
	);
	assert.equal(delivered, true);
	assert.equal(requeueCalls, 0);
	assert.deepEqual(calls[0]?.[1], { deliverAs: "followUp" });
});

test("deliverAssignedTaskPrompt requeues the task to pending when delivery throws", async () => {
	let requeueReason: string | undefined;
	const delivered = await deliverAssignedTaskPrompt(
		{
			sendUserMessage: () => {
				throw new Error("busy");
			},
			requeueTaskToPending: async (reason) => {
				requeueReason = reason;
			},
		},
		"do the thing",
	);
	assert.equal(delivered, false);
	assert.equal(typeof requeueReason, "string");
	assert.ok(requeueReason && requeueReason.length > 0);
});

// --- auto-claimed task prompt: followUp delivery, unassign on failure ---

test("deliverAutoClaimedTaskPrompt delivers as followUp and does not unassign on success", async () => {
	let unassignCalls = 0;
	const delivered = await deliverAutoClaimedTaskPrompt(
		{
			sendUserMessage: () => {},
			unassignTask: async () => {
				unassignCalls += 1;
			},
		},
		"do the thing",
	);
	assert.equal(delivered, true);
	assert.equal(unassignCalls, 0);
});

test("deliverAutoClaimedTaskPrompt unassigns (returns task to the pool) when delivery throws", async () => {
	let unassignCalls = 0;
	const delivered = await deliverAutoClaimedTaskPrompt(
		{
			sendUserMessage: () => {
				throw new Error("busy");
			},
			unassignTask: async () => {
				unassignCalls += 1;
			},
		},
		"do the thing",
	);
	assert.equal(delivered, false);
	assert.equal(unassignCalls, 1);
});

// --- queued DM delivery: followUp, never drop text on failure ---

test("deliverQueuedDmText delivers as followUp on success", () => {
	const calls: Array<[unknown, unknown]> = [];
	const delivered = deliverQueuedDmText((content, options) => calls.push([content, options]), "hello");
	assert.equal(delivered, true);
	assert.deepEqual(calls[0]?.[1], { deliverAs: "followUp" });
});

test("deliverQueuedDmText returns false (caller keeps queued text) when delivery throws", () => {
	const delivered = deliverQueuedDmText(() => {
		throw new Error("busy");
	}, "hello");
	assert.equal(delivered, false);
});

// --- agent_settled task finalize outcome (agent_end only captures; this is the settled-time decision) ---

test("computeTaskFinalizeOutcome marks a normal reply as completed", () => {
	const outcome = computeTaskFinalizeOutcome(
		[{ role: "assistant", content: "all done" } as never],
		{ taskId: null, requestId: null },
		"task-1",
	);
	assert.equal(outcome.kind, "completed");
	assert.equal((outcome as { kind: "completed"; result: string }).result, "all done");
});

test("computeTaskFinalizeOutcome marks a matching abort request as aborted with reason/requestId", () => {
	const outcome = computeTaskFinalizeOutcome(
		[{ role: "assistant", content: "partial work" } as never],
		{ taskId: "task-1", reason: "leader requested stop", requestId: "req-1" },
		"task-1",
	);
	assert.equal(outcome.kind, "aborted");
	const metadata = (outcome as { kind: "aborted"; metadata: Record<string, unknown> }).metadata;
	assert.equal(metadata.abortReason, "leader requested stop");
	assert.equal(metadata.abortRequestId, "req-1");
	assert.equal(metadata.partialResult, "partial work");
});

test("computeTaskFinalizeOutcome marks an empty reply as aborted with 'no assistant result'", () => {
	const outcome = computeTaskFinalizeOutcome([], { taskId: null, requestId: null }, "task-1");
	assert.equal(outcome.kind, "aborted");
	const metadata = (outcome as { kind: "aborted"; metadata: Record<string, unknown> }).metadata;
	assert.equal(metadata.abortReason, "no assistant result");
});

test("computeTaskFinalizeOutcome ignores an abort request targeting a different task", () => {
	const outcome = computeTaskFinalizeOutcome(
		[{ role: "assistant", content: "done anyway" } as never],
		{ taskId: "other-task", reason: "n/a", requestId: "req-1" },
		"task-1",
	);
	assert.equal(outcome.kind, "completed");
});

// --- idle-notification ordering: report completion before claiming/starting next task ---

test("planIdleNotifications notifies before next-work whenever a task just finished", () => {
	const plan = planIdleNotifications({
		hadTask: true,
		isStreamingAfterNextWork: true,
		hasCurrentTaskAfterNextWork: true,
	});
	assert.equal(plan.notifyBeforeNextWork, true);
	assert.equal(plan.notifyAfterNextWork, false);
});

test("planIdleNotifications sends exactly one notification when a task finished and nothing else started", () => {
	const plan = planIdleNotifications({
		hadTask: true,
		isStreamingAfterNextWork: false,
		hasCurrentTaskAfterNextWork: false,
	});
	assert.equal(plan.notifyBeforeNextWork, true);
	assert.equal(plan.notifyAfterNextWork, false);
});

test("planIdleNotifications sends a bare idle ping only when no task finished and the worker is still idle", () => {
	const plan = planIdleNotifications({
		hadTask: false,
		isStreamingAfterNextWork: false,
		hasCurrentTaskAfterNextWork: false,
	});
	assert.equal(plan.notifyBeforeNextWork, false);
	assert.equal(plan.notifyAfterNextWork, true);
});

test("planIdleNotifications sends nothing when no task finished and the worker started new work", () => {
	const plan = planIdleNotifications({
		hadTask: false,
		isStreamingAfterNextWork: true,
		hasCurrentTaskAfterNextWork: false,
	});
	assert.equal(plan.notifyBeforeNextWork, false);
	assert.equal(plan.notifyAfterNextWork, false);
});

// --- compaction gating before starting another task (never mid-task; resumed via onComplete/onError) ---

test("getCompactThresholdPercent defaults to 70 when unset", () => {
	assert.equal(getCompactThresholdPercent({}), 70);
});

test("getCompactThresholdPercent honors PI_TEAMS_COMPACT_THRESHOLD_PERCENT override", () => {
	assert.equal(getCompactThresholdPercent({ PI_TEAMS_COMPACT_THRESHOLD_PERCENT: "55" }), 55);
});

test("getCompactThresholdPercent falls back to default on invalid override", () => {
	assert.equal(getCompactThresholdPercent({ PI_TEAMS_COMPACT_THRESHOLD_PERCENT: "not-a-number" }), 70);
});

test("shouldCompactBeforeNextTask is disabled by a threshold of 0", () => {
	assert.equal(shouldCompactBeforeNextTask(99, 0), false);
});

test("shouldCompactBeforeNextTask triggers at/above the threshold", () => {
	assert.equal(shouldCompactBeforeNextTask(70, 70), true);
	assert.equal(shouldCompactBeforeNextTask(71, 70), true);
	assert.equal(shouldCompactBeforeNextTask(69, 70), false);
});

test("shouldCompactBeforeNextTask does not trigger when usage is unknown", () => {
	assert.equal(shouldCompactBeforeNextTask(null, 70), false);
	assert.equal(shouldCompactBeforeNextTask(undefined, 70), false);
});
