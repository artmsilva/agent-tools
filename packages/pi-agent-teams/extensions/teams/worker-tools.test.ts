import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkerToolPolicy } from "./worker-tools.js";

test("readonly teammates never regain all builtins when every requested tool is denied", () => {
	const policy = resolveWorkerToolPolicy({
		activeTools: ["read", "bash", "edit", "write"],
		requestedTools: ["bash", "edit", "write"],
		readonly: true,
	});
	assert.deepEqual(policy.tools, []);
	assert.deepEqual(policy.args, ["--no-builtin-tools"]);
});

test("worker allowlist retains the team_message control-plane tool", () => {
	const policy = resolveWorkerToolPolicy({
		activeTools: ["read", "bash", "edit"],
		requestedTools: ["read", "edit"],
	});
	assert.deepEqual(policy.tools, ["read", "edit"]);
	assert.deepEqual(policy.args, ["--tools", "read,edit,team_message"]);
});

test("agent definitions cannot grant tools unavailable to the leader", () => {
	const policy = resolveWorkerToolPolicy({ activeTools: ["read"], requestedTools: ["read", "bash"] });
	assert.deepEqual(policy.tools, ["read"]);
	assert.deepEqual(policy.warnings, ["Agent tool unavailable to teammate: bash"]);
});
