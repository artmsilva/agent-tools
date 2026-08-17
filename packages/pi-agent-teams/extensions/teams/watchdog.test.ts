import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateWatchdog, type WatchdogConfig } from "./watchdog.js";

const config: WatchdogConfig = { stallMs: 100, graceMs: 50, livenessMs: 30, maxRetries: 1 };

function decide(overrides: Partial<Parameters<typeof evaluateWatchdog>[0]> = {}) {
	return evaluateWatchdog({
		now: 1_000,
		taskId: "1",
		status: "streaming",
		lastProgressAt: 800,
		lastHeartbeatAt: 990,
		attempts: 0,
		state: null,
		config,
		...overrides,
	});
}

test("healthy or idle work resets watchdog state", () => {
	assert.equal(decide({ lastProgressAt: 950 }).action, "none");
	assert.equal(decide({ status: "idle" }).state, null);
});

test("stale heartbeat is runtime loss, not a progress stall", () => {
	assert.equal(decide({ lastHeartbeatAt: 900 }).action, "runtime_lost");
});

test("watchdog checkpoints, retries once, then requires attention", () => {
	const first = decide();
	assert.equal(first.action, "checkpoint");
	const waiting = decide({ now: 1_040, lastHeartbeatAt: 1_035, state: first.state });
	assert.equal(waiting.action, "none");
	const retry = decide({ now: 1_060, lastHeartbeatAt: 1_055, state: first.state });
	assert.equal(retry.action, "retry");
	const exhausted = decide({ now: 1_120, lastHeartbeatAt: 1_115, attempts: 1, state: retry.state });
	assert.equal(exhausted.action, "needs_attention");
	const noRepeat = decide({ now: 1_200, lastHeartbeatAt: 1_195, attempts: 1, state: exhausted.state });
	assert.equal(noRepeat.action, "none");
});
