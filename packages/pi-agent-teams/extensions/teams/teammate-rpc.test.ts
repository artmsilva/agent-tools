import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { TeammateRpc } from "./teammate-rpc.js";

async function fakePi(): Promise<{ dir: string; cleanup: () => void }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-rpc-"));
	const executable = path.join(dir, "pi");
	await fs.promises.writeFile(
		executable,
		`#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "set_session_name" && command.name === "fail") {
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "rejected" }) + "\\n");
    return;
  }
  if (command.type === "prompt" && command.message === "die") {
    process.exit(7);
  }
  if (command.type === "prompt") {
    process.stdout.write("not-json\\n" + JSON.stringify({ type: "agent_start" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
  }
  const response = JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { ready: true } }) + "\\n";
  process.stdout.write(response.slice(0, 5));
  setImmediate(() => process.stdout.write(response.slice(5)));
});
`,
		{ mode: 0o755 },
	);
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("RPC startup handles an immediate fragmented response and malformed lines", async (t) => {
	const fake = await fakePi();
	t.after(fake.cleanup);
	const teammate = new TeammateRpc("worker");
	const events: string[] = [];
	teammate.onEvent((event) => events.push(event.type));
	await teammate.start({ cwd: fake.dir, env: { PATH: `${fake.dir}:${process.env.PATH ?? ""}` }, args: [] });
	assert.equal(teammate.status, "idle");
	await teammate.prompt("work");
	assert.deepEqual(events, ["agent_start", "agent_end"]);
	await teammate.stop();
	assert.equal(teammate.status, "stopped");
});

test("RPC process exit rejects an in-flight command", async (t) => {
	const fake = await fakePi();
	t.after(fake.cleanup);
	const teammate = new TeammateRpc("worker");
	await teammate.start({ cwd: fake.dir, env: { PATH: `${fake.dir}:${process.env.PATH ?? ""}` }, args: [] });
	await assert.rejects(teammate.prompt("die"), /exited with code 7/);
	assert.equal(teammate.status, "error");
});

test("RPC command failures reject instead of appearing delivered", async (t) => {
	const fake = await fakePi();
	t.after(fake.cleanup);
	const teammate = new TeammateRpc("worker");
	await teammate.start({ cwd: fake.dir, env: { PATH: `${fake.dir}:${process.env.PATH ?? ""}` }, args: [] });
	await assert.rejects(teammate.setSessionName("fail"), /rejected/);
	await teammate.stop();
});
