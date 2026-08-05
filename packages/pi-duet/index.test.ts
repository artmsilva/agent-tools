import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai/compat";
import { assemblePrompt, buildBtwQuestion, isReplaySafe } from "./helpers.ts";

describe("assemblePrompt", () => {
	it("includes cwd and user message", () => {
		const result = assemblePrompt("/home/user/project", "What's the best approach?");
		assert.match(result, /working in \/home\/user\/project/);
		assert.match(result, /What's the best approach\?/);
	});
});

describe("buildBtwQuestion", () => {
	it("keeps the side call tool-free and scoped to existing context", () => {
		const message = buildBtwQuestion("Why this file?");
		assert.equal(message.role, "user");
		assert.match(String(message.content), /no tools/i);
		assert.match(String(message.content), /Why this file\?/);
	});
});

describe("isReplaySafe", () => {
	const assistant = (content: unknown[]) => ({ role: "assistant", content }) as Message;
	const result = (toolCallId: string) => ({ role: "toolResult", toolCallId, content: [] }) as Message;

	it("accepts completed tool calls", () => {
		assert.equal(isReplaySafe([
			assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
			result("call-1"),
		]), true);
	});

	it("rejects a tool call still awaiting its result", () => {
		assert.equal(isReplaySafe([
			assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		]), false);
	});

	it("rejects orphaned tool results", () => {
		assert.equal(isReplaySafe([result("missing")]), false);
	});
});
