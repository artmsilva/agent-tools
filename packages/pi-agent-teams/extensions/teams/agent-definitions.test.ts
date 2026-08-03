import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadTeammateAgentDefinition } from "./agent-definitions.js";

async function fixture(): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-agent-def-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent-home");
	await fs.promises.mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
	await fs.promises.mkdir(path.join(agentDir, "agents"), { recursive: true });
	return { root, cwd, agentDir };
}

test("project agent definitions override global definitions", async (t) => {
	const { root, cwd, agentDir } = await fixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	await fs.promises.writeFile(
		path.join(agentDir, "agents", "reviewer.md"),
		"---\nmodel: global/model\n---\nglobal prompt\n",
	);
	await fs.promises.writeFile(
		path.join(cwd, ".pi", "agents", "reviewer.md"),
		"---\ndescription: Review code\nmodel: anthropic/claude-sonnet-5\nthinking: max\ntools: read, grep, edit, write\nreadonly: true\n---\nproject prompt\n",
	);

	const definition = await loadTeammateAgentDefinition("reviewer", { cwd, agentDir });
	assert.equal(definition.source, "project");
	assert.equal(definition.model, "anthropic/claude-sonnet-5");
	assert.equal(definition.thinking, "max");
	assert.deepEqual(definition.tools, ["read", "grep"]);
	assert.equal(definition.prompt, "project prompt");
	assert.equal(definition.readonly, true);
});

test("agent definitions reject traversal, missing, and disabled names", async (t) => {
	const { root, cwd, agentDir } = await fixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	await fs.promises.writeFile(path.join(agentDir, "agents", "off.md"), "---\ndisabled: true\n---\nnope\n");
	await assert.rejects(loadTeammateAgentDefinition("../secret", { cwd, agentDir }), /Invalid agent/);
	await assert.rejects(loadTeammateAgentDefinition("missing", { cwd, agentDir }), /not found/);
	await assert.rejects(loadTeammateAgentDefinition("off", { cwd, agentDir }), /disabled/);
});
