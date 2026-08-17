import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbortRequestMessage } from "./protocol.js";

test("abort recovery fields are parsed only from trusted enum values", () => {
	const parsed = isAbortRequestMessage(JSON.stringify({
		type: "abort_request",
		requestId: "req-1",
		taskId: "7",
		recoveryAction: "retry",
		recoveryAttempt: 1,
	}));
	assert.equal(parsed?.recoveryAction, "retry");
	assert.equal(parsed?.recoveryAttempt, 1);

	const invalid = isAbortRequestMessage(JSON.stringify({
		type: "abort_request",
		requestId: "req-2",
		recoveryAction: "loop_forever",
	}));
	assert.equal(invalid?.recoveryAction, undefined);
});
