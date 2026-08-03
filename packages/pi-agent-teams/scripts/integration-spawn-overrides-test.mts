/**
 * Integration test: validate /team spawn model + thinking overrides end-to-end.
 *
 * What this covers:
 * - Spawn with explicit --model <provider>/<modelId> + --thinking <level>
 * - Spawn with --model <modelId> only (provider inherited from leader)
 * - Validation errors for invalid thinking and invalid model override formats
 *
 * Usage:
 *   npx tsx scripts/integration-spawn-overrides-test.mts
 *   npx tsx scripts/integration-spawn-overrides-test.mts --timeoutSec 90
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { sleep, terminateAll } from "./lib/pi-workers.js";

interface MemberSnapshot {
	name: string;
	status?: string;
	meta?: Record<string, unknown>;
}

interface NotifyEvent {
	notifyType: string;
	message: string;
}

type RpcCommand = { id?: string; type: "get_state" } | { id?: string; type: "prompt"; message: string };

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type PendingRequest = {
	resolve: (v: RpcResponse) => void;
	reject: (e: Error) => void;
	timeout: NodeJS.Timeout;
};

function parseArgs(argv: readonly string[]): { timeoutSec: number } {
	let timeoutSec = 90;

	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--timeoutSec") {
			const v = argv[i + 1];
			if (v) timeoutSec = Number.parseInt(v, 10);
			i += 1;
		}
	}

	if (!Number.isFinite(timeoutSec) || timeoutSec < 20) timeoutSec = 90;
	return { timeoutSec };
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function safeJsonParse(line: string): unknown | null {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

function isRpcResponse(v: unknown): v is RpcResponse {
	if (!isRecord(v)) return false;
	if (v.type !== "response") return false;
	if (typeof v.command !== "string") return false;
	if (typeof v.success !== "boolean") return false;
	if (v.id !== undefined && typeof v.id !== "string") return false;
	if (v.error !== undefined && typeof v.error !== "string") return false;
	return true;
}

function isNotifyExtensionUiRequest(v: unknown): v is { notifyType: string; message: string } {
	if (!isRecord(v)) return false;
	if (v.type !== "extension_ui_request") return false;
	if (v.method !== "notify") return false;
	if (typeof v.message !== "string") return false;
	if (typeof v.notifyType !== "string") return false;
	return true;
}

async function waitFor(
	fn: () => boolean | Promise<boolean>,
	opts: { timeoutMs: number; pollMs: number; label: string },
): Promise<void> {
	const { timeoutMs, pollMs, label } = opts;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await sleep(pollMs);
	}
	throw new Error(`Timeout waiting for ${label}`);
}

function readConfig(teamDir: string): unknown | null {
	const configPath = path.join(teamDir, "config.json");
	try {
		return JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
	} catch {
		return null;
	}
}

function findMember(teamDir: string, name: string): MemberSnapshot | null {
	const cfg = readConfig(teamDir);
	if (!isRecord(cfg)) return null;

	const members = cfg.members;
	if (!Array.isArray(members)) return null;

	for (const m of members) {
		if (!isRecord(m)) continue;
		if (m.name !== name) continue;

		const status = typeof m.status === "string" ? m.status : undefined;
		const meta = isRecord(m.meta) ? m.meta : undefined;
		return { name, status, meta };
	}

	return null;
}

function getMetaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!meta) return undefined;
	const v = meta[key];
	return typeof v === "string" ? v : undefined;
}

function extractSessionId(resp: RpcResponse): string | null {
	if (!isRecord(resp.data)) return null;
	const sessionId = resp.data.sessionId;
	return typeof sessionId === "string" ? sessionId : null;
}

function messagesContain(events: readonly NotifyEvent[], needle: string): boolean {
	const n = needle.toLowerCase();
	return events.some((e) => e.message.toLowerCase().includes(n));
}

const { timeoutSec } = parseArgs(process.argv.slice(2));

const teamsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-spawn-overrides-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");

if (!fs.existsSync(entryPath)) {
	throw new Error(`Teams extension entry not found: ${entryPath}`);
}

console.log(`teamsRootDir: ${teamsRootDir}`);
console.log(`entryPath: ${entryPath}`);

const leaderEnv = {
	...process.env,
	PI_TEAMS_ROOT_DIR: teamsRootDir,
	PI_TEAMS_WORKER: "0",
	PI_TEAMS_TEAM_ID: "",
	PI_TEAMS_AGENT_NAME: "",
	PI_TEAMS_TASK_LIST_ID: "",
	PI_TEAMS_LEAD_NAME: "",
	PI_TEAMS_AUTO_CLAIM: "",
};

const leaderArgs = [
	"--mode",
	"rpc",
	"--no-session",
	"--provider",
	"openai-codex",
	"--model",
	"gpt-5.1-codex-mini",
	"--thinking",
	"minimal",
	"--no-extensions",
	"-e",
	entryPath,
];

const leader = spawn("pi", leaderArgs, {
	cwd: repoRoot,
	env: leaderEnv,
	stdio: ["pipe", "pipe", "pipe"],
});

const procs: ChildProcess[] = [leader];
const notifications: NotifyEvent[] = [];
const pending = new Map<string, PendingRequest>();
let nextId = 1;
let stderr = "";

leader.stderr.on("data", (d: Buffer | string) => {
	stderr += d.toString();
});

leader.on("close", () => {
	for (const [id, p] of pending.entries()) {
		clearTimeout(p.timeout);
		p.reject(new Error(`Leader closed before response (id=${id}). stderr=${stderr}`));
	}
	pending.clear();
});

const rl = readline.createInterface({ input: leader.stdout, crlfDelay: Infinity });
rl.on("line", (line: string) => {
	const obj = safeJsonParse(line);
	if (obj === null) return;

	if (isRpcResponse(obj)) {
		if (!obj.id) return;
		const req = pending.get(obj.id);
		if (!req) return;
		pending.delete(obj.id);
		clearTimeout(req.timeout);
		req.resolve(obj);
		return;
	}

	if (isNotifyExtensionUiRequest(obj)) {
		notifications.push({ notifyType: obj.notifyType, message: obj.message });
		console.log(`[notify:${obj.notifyType}] ${obj.message}`);
	}
});

const send = async (command: RpcCommand): Promise<RpcResponse> => {
	const id = command.id ?? `req-${nextId++}`;
	const payload = JSON.stringify({ ...command, id }) + "\n";

	leader.stdin.write(payload);

	return await new Promise<RpcResponse>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			reject(new Error(`Timeout waiting for response to ${command.type}. stderr=${stderr}`));
		}, timeoutSec * 1000);

		pending.set(id, { resolve, reject, timeout });
	});
};

const sendPrompt = async (message: string): Promise<void> => {
	console.log(`prompt: ${message}`);
	const resp = await send({ type: "prompt", message });
	if (!resp.success) {
		throw new Error(`Prompt failed: ${resp.error ?? "unknown error"}`);
	}
};

let teamDir = "";

const waitForMemberStatus = async (name: string, status: "online" | "offline"): Promise<MemberSnapshot> => {
	let snapshot: MemberSnapshot | null = null;
	await waitFor(
		() => {
			snapshot = findMember(teamDir, name);
			return snapshot !== null && snapshot.status === status;
		},
		{ timeoutMs: timeoutSec * 1000, pollMs: 250, label: `member ${name} ${status}` },
	);
	if (!snapshot) throw new Error(`Missing snapshot for ${name}`);
	return snapshot;
};

const waitForMemberOverrides = async (
	name: string,
	expectedThinking: string,
	expectedModel: string,
): Promise<MemberSnapshot> => {
	let snapshot: MemberSnapshot | null = null;
	await waitFor(
		() => {
			snapshot = findMember(teamDir, name);
			if (!snapshot || snapshot.status !== "online") return false;
			const thinking = getMetaString(snapshot.meta, "thinkingLevel");
			const model = getMetaString(snapshot.meta, "model");
			return thinking === expectedThinking && model === expectedModel;
		},
		{ timeoutMs: timeoutSec * 1000, pollMs: 250, label: `member ${name} override metadata` },
	);
	if (!snapshot) throw new Error(`Missing snapshot for ${name}`);
	return snapshot;
};

try {
	const state = await send({ type: "get_state" });
	if (!state.success) throw new Error(`get_state failed: ${state.error ?? "unknown error"}`);

	const leaderSessionId = extractSessionId(state);
	if (!leaderSessionId) throw new Error(`No sessionId in get_state response: ${JSON.stringify(state)}`);

	teamDir = path.join(teamsRootDir, leaderSessionId);
	console.log(`leaderSessionId: ${leaderSessionId}`);
	console.log(`teamDir: ${teamDir}`);

	// 1) Explicit provider/model + thinking override.
	await sendPrompt("/team spawn alice fresh --model openai-codex/gpt-5.1-codex-mini --thinking high");
	const alice = await waitForMemberOverrides("alice", "high", "openai-codex/gpt-5.1-codex-mini");

	assert(
		getMetaString(alice.meta, "model") === "openai-codex/gpt-5.1-codex-mini",
		`alice model mismatch: ${getMetaString(alice.meta, "model") ?? "<missing>"}`,
	);
	assert(
		getMetaString(alice.meta, "thinkingLevel") === "high",
		`alice thinking mismatch: ${getMetaString(alice.meta, "thinkingLevel") ?? "<missing>"}`,
	);
	console.log("OK: alice model/thinking overrides recorded");

	// 2) Model id only -> inherit provider from leader.
	await sendPrompt("/team spawn bob fresh --model gpt-5.1-codex-mini --thinking low");
	const bob = await waitForMemberOverrides("bob", "low", "openai-codex/gpt-5.1-codex-mini");

	assert(
		getMetaString(bob.meta, "model") === "openai-codex/gpt-5.1-codex-mini",
		`bob model mismatch: ${getMetaString(bob.meta, "model") ?? "<missing>"}`,
	);
	assert(
		getMetaString(bob.meta, "thinkingLevel") === "low",
		`bob thinking mismatch: ${getMetaString(bob.meta, "thinkingLevel") ?? "<missing>"}`,
	);
	console.log("OK: bob inherited provider for model-only override");

	// 3) Invalid thinking value is rejected by command parser.
	const beforeInvalidThinking = notifications.length;
	await sendPrompt("/team spawn charlie fresh --thinking nope");
	await sleep(150);
	const invalidThinkingEvents = notifications.slice(beforeInvalidThinking);

	assert(findMember(teamDir, "charlie") === null, "charlie should not be spawned for invalid thinking");
	assert(
		messagesContain(invalidThinkingEvents, "invalid thinking level"),
		"expected invalid thinking level notification",
	);
	console.log("OK: invalid thinking level rejected");

	// 4) Invalid model override shape is rejected by spawn layer.
	const beforeInvalidModel = notifications.length;
	await sendPrompt("/team spawn dave fresh --model openai-codex/ --thinking low");
	await sleep(150);
	const invalidModelEvents = notifications.slice(beforeInvalidModel);

	assert(findMember(teamDir, "dave") === null, "dave should not be spawned for invalid model override");
	assert(messagesContain(invalidModelEvents, "invalid model override"), "expected invalid model override notification");
	console.log("OK: invalid model override rejected");

	// 5) Deprecated model override is rejected by model policy.
	const beforeDeprecatedModel = notifications.length;
	await sendPrompt("/team spawn erin fresh --model anthropic/claude-sonnet-4 --thinking low");
	await sleep(150);
	const deprecatedModelEvents = notifications.slice(beforeDeprecatedModel);

	assert(findMember(teamDir, "erin") === null, "erin should not be spawned for deprecated model override");
	assert(messagesContain(deprecatedModelEvents, "deprecated"), "expected deprecated model override notification");
	console.log("OK: deprecated model override rejected");

	// Shutdown spawned teammates.
	await sendPrompt("/team shutdown");
	await waitForMemberStatus("alice", "offline");
	await waitForMemberStatus("bob", "offline");
	console.log("OK: teammates shutdown cleanly");

	console.log("PASS: integration spawn override test passed");
} finally {
	try {
		rl.close();
	} catch {
		// ignore
	}

	await terminateAll(procs);

	try {
		fs.rmSync(teamsRootDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}
