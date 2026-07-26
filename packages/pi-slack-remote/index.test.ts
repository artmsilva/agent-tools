import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("an in-flight poll ignores its context after session shutdown", async () => {
	const originalFetch = globalThis.fetch;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const originalToken = process.env.SLACK_BOT_TOKEN;
	const originalUserId = process.env.PI_SLACK_USER_ID;
	const originalRemote = process.env.PI_SLACK_REMOTE;
	let runPoll: (() => void) | undefined;
	let resolveReplies: ((value: Response) => void) | undefined;

	process.env.SLACK_BOT_TOKEN = "test-token";
	process.env.PI_SLACK_USER_ID = "U1";
	process.env.PI_SLACK_REMOTE = "on";
	globalThis.setInterval = ((callback: () => void) => {
		runPoll = callback;
		return { unref() {} } as NodeJS.Timeout;
	}) as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;
	globalThis.fetch = (async (input) => {
		const method = new URL(String(input)).pathname.split("/").pop();
		const body =
			method === "auth.test"
				? { ok: true, user_id: "B1" }
				: method === "conversations.open"
					? { ok: true, channel: { id: "D1" } }
					: method === "conversations.replies"
						? await new Promise<Response>((resolve) => {
								resolveReplies = resolve;
							})
						: { ok: true, ts: "1", messages: [] };
		return body instanceof Response ? body : Response.json(body);
	}) as typeof fetch;

	try {
		const { default: register } = await import(`./index.ts?test=${Date.now()}`);
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		register({
			on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
			registerCommand() {},
			sendUserMessage() {},
		} as unknown as ExtensionAPI);

		let stale = false;
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getSessionName: () => "test", getSessionId: () => "session-1" },
			get hasUI() {
				if (stale) throw new Error("stale context");
				return true;
			},
			get ui() {
				if (stale) throw new Error("stale context");
				return { setStatus() {} };
			},
			isIdle: () => true,
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.ok(runPoll);
		runPoll();
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(resolveReplies);

		stale = true;
		await handlers.get("session_shutdown")?.({}, ctx);
		resolveReplies(Response.json({
			ok: true,
			messages: [{ ts: "2", user: "U1", text: "continue" }],
		}));
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
		else process.env.SLACK_BOT_TOKEN = originalToken;
		if (originalUserId === undefined) delete process.env.PI_SLACK_USER_ID;
		else process.env.PI_SLACK_USER_ID = originalUserId;
		if (originalRemote === undefined) delete process.env.PI_SLACK_REMOTE;
		else process.env.PI_SLACK_REMOTE = originalRemote;
	}
});

test("remote turns mention Slack limits and outbound posts are locally clipped", async () => {
	const originalFetch = globalThis.fetch;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const originalToken = process.env.SLACK_BOT_TOKEN;
	const originalUserId = process.env.PI_SLACK_USER_ID;
	const originalRemote = process.env.PI_SLACK_REMOTE;
	const postedTexts: string[] = [];

	process.env.SLACK_BOT_TOKEN = "test-token";
	process.env.PI_SLACK_USER_ID = "U1";
	process.env.PI_SLACK_REMOTE = "on";
	globalThis.setInterval = (() => ({ unref() {} }) as NodeJS.Timeout) as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;
	globalThis.fetch = (async (input, init) => {
		const method = new URL(String(input)).pathname.split("/").pop();
		if (method === "chat.postMessage") {
			postedTexts.push(JSON.parse(String(init?.body)).text);
			return Response.json({ ok: true, ts: "1" });
		}
		const body =
			method === "auth.test"
				? { ok: true, user_id: "B1" }
				: method === "conversations.open"
					? { ok: true, channel: { id: "D1" } }
					: { ok: true, messages: [] };
		return Response.json(body);
	}) as typeof fetch;

	try {
		const { default: register } = await import(`./index.ts?test=${Date.now()}-${Math.random()}`);
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		register({
			on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
			registerCommand() {},
			sendUserMessage() {},
		} as unknown as ExtensionAPI);

		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getSessionName: () => "x".repeat(41000), getSessionId: () => "session-1" },
			hasUI: true,
			ui: { setStatus() {} },
			isIdle: () => true,
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.ok(postedTexts[0].length <= 40000);
		assert.match(postedTexts[0], /truncated locally/);

		const result = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx)) as {
			systemPrompt?: string;
		};
		assert.match(result.systemPrompt ?? "", /4,000/);
		assert.match(result.systemPrompt ?? "", /40,000/);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
		else process.env.SLACK_BOT_TOKEN = originalToken;
		if (originalUserId === undefined) delete process.env.PI_SLACK_USER_ID;
		else process.env.PI_SLACK_USER_ID = originalUserId;
		if (originalRemote === undefined) delete process.env.PI_SLACK_REMOTE;
		else process.env.PI_SLACK_REMOTE = originalRemote;
	}
});
