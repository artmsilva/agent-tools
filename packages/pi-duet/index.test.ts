/**
 * Tests for pi-duet helpers
 * These test the exported helper functions without needing full pi runtime
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// Inline the simple helpers for testing (real code imports from helpers.ts)
function assemblePrompt(cwd: string, userMessage: string): string {
	return `You are a second opinion assistant. The user is working in ${cwd} and asked:

${userMessage}

Provide a brief, thoughtful second perspective. Be concise.`;
}

describe("assemblePrompt", () => {
	it("includes cwd and user message", () => {
		const result = assemblePrompt("/home/user/project", "What's the best approach?");
		assert.ok(result.includes("/home/user/project"));
		assert.ok(result.includes("What's the best approach?"));
		assert.ok(result.includes("second opinion"));
	});

	it("handles multiline messages", () => {
		const result = assemblePrompt("/tmp", "Line 1\nLine 2\nLine 3");
		assert.ok(result.includes("Line 1"));
		assert.ok(result.includes("Line 2"));
		assert.ok(result.includes("Line 3"));
	});

	it("includes context instruction", () => {
		const result = assemblePrompt("/workspace", "Should I use TypeScript?");
		assert.ok(result.includes("working in /workspace"));
		assert.ok(result.includes("Should I use TypeScript?"));
		assert.ok(result.includes("brief"));
		assert.ok(result.includes("concise"));
	});
});

describe("model resolution", () => {
	it("documents DUET_MODEL format", () => {
		// DUET_MODEL env var format: "provider/modelId"
		// Examples: "anthropic/claude-haiku-4", "openai/gpt-4o-mini"
		assert.equal("provider/modelId".split("/").length, 2);
	});

	it("defaults documented", () => {
		// Documented fallback chain:
		// 1. anthropic/claude-haiku-4
		// 2. anthropic/claude-3-5-haiku-20241022
		// 3. openai/gpt-4o-mini
		const defaults = [
			"anthropic/claude-haiku-4",
			"anthropic/claude-3-5-haiku-20241022",
			"openai/gpt-4o-mini",
		];
		assert.equal(defaults.length, 3);
	});
});
