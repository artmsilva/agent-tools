import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrClient } from "./herdr-client.js";
import { TeammateHerdr } from "./teammate-herdr.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Herdr progress advances only when status or terminal output changes", async (t) => {
	let output = "working";
	const client = {
		launch: async () => ({ paneId: "pane-1", workspaceId: "ws-1", agentName: "agent-1" }),
		paneState: async () => ({ result: { pane: { agent_status: "working" } } }),
		readAgent: async () => output,
		close: async () => undefined,
		message: async () => undefined,
		interrupt: async () => undefined,
	} as unknown as HerdrClient;
	const teammate = await TeammateHerdr.start(client, {
		name: "worker",
		cwd: "/tmp",
		env: {},
		args: [],
		teamDir: "/tmp/team",
		teamId: "team",
	});
	t.after(() => void teammate.stop());
	const poll = (teammate as unknown as { poll(): Promise<void> }).poll.bind(teammate);

	await poll();
	const first = teammate.lastEventAt;
	await wait(5);
	await poll();
	assert.equal(teammate.lastEventAt, first);

	output = "new terminal output";
	await wait(5);
	await poll();
	assert.ok(teammate.lastEventAt > first);
	assert.equal(teammate.lastAssistantText, output);
});
