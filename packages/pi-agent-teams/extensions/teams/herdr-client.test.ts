import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { HerdrClient, getTeamDisplayMode, type HerdrRunner } from "./herdr-client.js";

async function tempDir(t: TestContext): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-herdr-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("display mode is auto unless explicitly forced", () => {
	assert.equal(getTeamDisplayMode({}), "auto");
	assert.equal(getTeamDisplayMode({ PI_TEAMS_DISPLAY: "rpc" }), "rpc");
	assert.equal(getTeamDisplayMode({ PI_TEAMS_DISPLAY: "herdr" }), "herdr");
});

test("Herdr availability parses status JSON instead of trusting exit code", async () => {
	const stopped = new HerdrClient(async () => JSON.stringify({ status: "not_running", running: false }));
	const running = new HerdrClient(async () => JSON.stringify({ status: "running", running: true }));
	assert.equal(await stopped.isAvailable(), false);
	assert.equal(await running.isAvailable(), true);
});

test("bootstraps one visible Ghostty Herdr session when the server is absent", async (t) => {
	const teamDir = await tempDir(t);
	let serverRunning = false;
	let clientAttached = false;
	const launches: string[] = [];
	const calls: string[][] = [];
	const runner: HerdrRunner = async (args) => {
		calls.push(args);
		const command = args[0] === "--session" ? args.slice(2) : args;
		if (command[0] === "status" && command[1] === "server") {
			return JSON.stringify({ status: serverRunning ? "running" : "not_running", running: serverRunning });
		}
		if (command[0] === "status" && command[1] === "client") {
			return JSON.stringify({ session: clientAttached ? "pi-team-team-1" : null });
		}
		return "{}";
	};
	const launcher = async (sessionName: string) => {
		launches.push(sessionName);
		serverRunning = true;
		clientAttached = true;
	};
	const client = new HerdrClient(runner, {}, launcher, async () => undefined);
	await Promise.all([
		client.ensureVisibleSession(teamDir, "team-1"),
		client.ensureVisibleSession(teamDir, "team-1"),
	]);
	assert.deepEqual(launches, ["pi-team-team-1"]);
	const persisted = JSON.parse(await fs.promises.readFile(path.join(teamDir, "herdr-ghostty.json"), "utf8")) as { sessionName: string };
	assert.equal(persisted.sessionName, "pi-team-team-1");

	await fs.promises.writeFile(
		path.join(teamDir, "herdr-runtime.json"),
		JSON.stringify({ version: 1, workspaceId: "ws-1", ownedWorkspace: true, panes: { worker: "pane-1" } }),
	);
	await client.close(teamDir, "worker", "pane-1");
	assert.equal(calls.some((args) => args.join(" ") === "session stop pi-team-team-1"), true);
	assert.equal(calls.some((args) => args.join(" ") === "session delete pi-team-team-1"), true);
	assert.equal(fs.existsSync(path.join(teamDir, "herdr-ghostty.json")), false);
});

test("visible-session bootstrap fails clearly after its bounded timeout", async (t) => {
	const teamDir = await tempDir(t);
	const client = new HerdrClient(
		async (args) => {
			const command = args[0] === "--session" ? args.slice(2) : args;
			if (command[0] === "status" && command[1] === "server") return JSON.stringify({ running: false });
			if (command[0] === "status" && command[1] === "client") return JSON.stringify({ session: null });
			return "{}";
		},
		{ PI_TEAMS_HERDR_BOOT_TIMEOUT_MS: "1" },
		async () => undefined,
		async () => undefined,
	);
	await assert.rejects(client.ensureVisibleSession(teamDir, "timeout"), /Timed out waiting for visible Herdr session/);
});

test("launches a teammate as a Herdr tab in the current workspace", async (t) => {
	const teamDir = await tempDir(t);
	const calls: string[][] = [];
	const runner: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "tab") return JSON.stringify({ result: { root_pane: { pane_id: "pane-1" } } });
		return "{}";
	};
	const client = new HerdrClient(runner, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "ws-1" });
	const launched = await client.launch({
		name: "reviewer",
		cwd: "/tmp/worktree",
		env: { PI_TEAMS_WORKER: "1" },
		args: ["--model", "test"],
		teamDir,
		teamId: "team-1",
	});

	assert.deepEqual(launched, { paneId: "pane-1", workspaceId: "ws-1", agentName: "pi-team-team-1-reviewer" });
	assert.deepEqual(calls[0], [
		"tab", "create", "--workspace", "ws-1", "--label", "Team: reviewer", "--cwd", "/tmp/worktree", "--no-focus", "--env", "PI_TEAMS_WORKER=1",
	]);
	assert.deepEqual(calls[1], [
		"agent", "start", "pi-team-team-1-reviewer", "--kind", "pi", "--pane", "pane-1", "--timeout", "60000", "--", "--model", "test",
	]);
});

test("retries agent start while a new Herdr shell is still busy", async (t) => {
	const teamDir = await tempDir(t);
	let starts = 0;
	const runner: HerdrRunner = async (args) => {
		if (args[0] === "workspace") {
			return JSON.stringify({ result: { workspace: { workspace_id: "ws" }, root_pane: { pane_id: "pane" } } });
		}
		if (args[0] === "agent" && args[1] === "start" && starts++ < 2) {
			throw Object.assign(new Error("busy"), { stderr: '{"error":{"code":"agent_pane_busy"}}' });
		}
		return "{}";
	};
	const launched = await new HerdrClient(runner, {}).launch({ name: "worker", cwd: teamDir, env: {}, args: [], teamDir, teamId: "team" });
	assert.equal(launched.paneId, "pane");
	assert.equal(starts, 3);
});

test("creates one owned Herdr workspace and closes it after the final teammate", async (t) => {
	const teamDir = await tempDir(t);
	const calls: string[][] = [];
	let pane = 0;
	const runner: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "workspace" && args[1] === "create") {
			return JSON.stringify({ result: { workspace: { workspace_id: "ws-owned" }, root_pane: { pane_id: "pane-1" } } });
		}
		if (args[0] === "workspace" && args[1] === "get") return "{}";
		if (args[0] === "tab") return JSON.stringify({ result: { root_pane: { pane_id: `pane-${++pane + 1}` } } });
		return "{}";
	};
	const client = new HerdrClient(runner, {});
	const first = await client.launch({ name: "one", cwd: teamDir, env: {}, args: [], teamDir, teamId: "team" });
	const second = await client.launch({ name: "two", cwd: teamDir, env: {}, args: [], teamDir, teamId: "team" });
	await client.close(teamDir, "one", first.paneId);
	assert.equal(calls.some((args) => args[0] === "workspace" && args[1] === "close"), false);
	await client.close(teamDir, "two", second.paneId);
	assert.equal(calls.some((args) => args[0] === "workspace" && args[1] === "close" && args[2] === "ws-owned"), true);
});

test("cleanup recovers the named session before closing bootstrapped panes", async (t) => {
	const teamDir = await tempDir(t);
	await fs.promises.writeFile(
		path.join(teamDir, "herdr-runtime.json"),
		JSON.stringify({ version: 1, workspaceId: "ws-1", ownedWorkspace: true, panes: { worker: "pane-1" } }),
	);
	await fs.promises.writeFile(
		path.join(teamDir, "herdr-ghostty.json"),
		JSON.stringify({ version: 1, sessionName: "pi-team-recovered", launchedAt: new Date(0).toISOString() }),
	);
	const calls: string[][] = [];
	const client = new HerdrClient(async (args) => {
		calls.push(args);
		return "{}";
	});
	await client.cleanupTeam(teamDir);
	assert.equal(calls.some((args) => args.join(" ") === "--session pi-team-recovered pane close pane-1"), true);
	assert.equal(calls.some((args) => args.join(" ") === "--session pi-team-recovered workspace close ws-1"), true);
});

test("refuses to discard invalid Herdr recovery state", async (t) => {
	const teamDir = await tempDir(t);
	await fs.promises.writeFile(path.join(teamDir, "herdr-runtime.json"), "not json");
	const client = new HerdrClient(async () => "{}", {});
	await assert.rejects(client.cleanupTeam(teamDir), /Invalid Herdr runtime state/);
	assert.equal(fs.existsSync(path.join(teamDir, "herdr-runtime.json")), true);
});

test("rolls back a newly-created Herdr workspace when agent startup fails", async (t) => {
	const teamDir = await tempDir(t);
	const calls: string[][] = [];
	const runner: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "workspace" && args[1] === "create") {
			return JSON.stringify({ result: { workspace: { workspace_id: "ws-fail" }, root_pane: { pane_id: "pane-fail" } } });
		}
		if (args[0] === "agent") throw new Error("startup failed");
		return "{}";
	};
	const client = new HerdrClient(runner, {});
	await assert.rejects(
		client.launch({ name: "broken", cwd: teamDir, env: {}, args: [], teamDir, teamId: "team" }),
		/startup failed/,
	);
	assert.equal(calls.some((args) => args.join(" ") === "pane close pane-fail"), true);
	assert.equal(calls.some((args) => args.join(" ") === "workspace close ws-fail"), true);
});
