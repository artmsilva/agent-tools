import assert from "node:assert/strict";
import test from "node:test";
import { buildStackArgs } from "./gh-stack.ts";

test("builds non-interactive stacked PR commands", () => {
	assert.deepEqual(buildStackArgs({ action: "submit", open: true }), ["stack", "submit", "--auto", "--open"]);
	assert.deepEqual(buildStackArgs({ action: "link", targets: ["one", "two"], base: "develop" }), [
		"stack", "link", "one", "two", "--base", "develop",
	]);
	assert.deepEqual(buildStackArgs({ action: "merge", target: "42", mergeMethod: "squash" }), [
		"stack", "merge", "42", "--yes", "--squash",
	]);
	assert.throws(() => buildStackArgs({ action: "init" }), /at least one/);
	assert.throws(() => buildStackArgs({ action: "add" }), /target or message/);
	assert.throws(() => buildStackArgs({ action: "checkout" }), /target is required/);
	assert.throws(() => buildStackArgs({ action: "merge" }), /mergeMethod is required/);
});
