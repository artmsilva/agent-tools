/**
 * Integration test: end-to-end quality-gate remediation loop.
 *
 * Validates a deterministic leader-only flow:
 * 1) Team-level hooks policy set to reopen+followup
 * 2) Completed task emits idle_notification -> task_completed hook runs and fails
 * 3) Leader auto-remediates:
 *    - marks task gate failure metadata
 *    - reopens original task to pending
 *    - creates + assigns follow-up task
 *    - sends remediation nudge mailbox message
 *
 * Usage:
 *   npx tsx scripts/integration-hooks-remediation-test.mts
 *   npx tsx scripts/integration-hooks-remediation-test.mts --timeoutSec 90
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeToMailbox, getInboxPath } from "../extensions/teams/mailbox.js";
import { TEAM_CONTROL_NS } from "../extensions/teams/protocol.js";
import { createTask, getTask, listTasks, updateTask, type TeamTask } from "../extensions/teams/task-store.js";
import { updateTeamHooksPolicy } from "../extensions/teams/team-config.js";
import { sleep, terminateAll } from "./lib/pi-workers.js";

type RpcCommand = { id?: string; type: "get_state" };

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

type MailboxMessageWire = {
	from: string;
	text: string;
	timestamp: string;
	read?: boolean;
	color?: string;
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

function isMailboxMessageWire(v: unknown): v is MailboxMessageWire {
	if (!isRecord(v)) return false;
	if (typeof v.from !== "string") return false;
	if (typeof v.text !== "string") return false;
	if (typeof v.timestamp !== "string") return false;
	if (v.read !== undefined && typeof v.read !== "boolean") return false;
	if (v.color !== undefined && typeof v.color !== "string") return false;
	return true;
}

function extractSessionId(resp: RpcResponse): string | null {
	if (!isRecord(resp.data)) return null;
	const sessionId = resp.data.sessionId;
	return typeof sessionId === "string" ? sessionId : null;
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

function loadMailboxMessages(filePath: string): MailboxMessageWire[] {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isMailboxMessageWire);
	} catch {
		return [];
	}
}

function findFollowupTask(tasks: readonly TeamTask[], originalTaskId: string): TeamTask | null {
	const marker = `(task #${originalTaskId})`;
	for (const task of tasks) {
		if (task.subject.startsWith("Quality gate failed:") && task.subject.includes(marker)) return task;
	}
	return null;
}

const { timeoutSec } = parseArgs(process.argv.slice(2));

const teamsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-hooks-remediation-"));
const hooksDir = path.join(teamsRootDir, "_hooks");
fs.mkdirSync(hooksDir, { recursive: true });

const hookSentinelFile = path.join(teamsRootDir, "hook-sentinel.txt");
fs.writeFileSync(
	path.join(hooksDir, "on_task_completed.js"),
	"" +
		"const fs = require('node:fs');\n" +
		`fs.writeFileSync(${JSON.stringify(hookSentinelFile)}, 'failed\\n', 'utf8');\n` +
		"console.error('integration hook failure sentinel');\n" +
		"process.exit(17);\n",
	"utf8",
);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");

if (!fs.existsSync(entryPath)) {
	throw new Error(`Teams extension entry not found: ${entryPath}`);
}

console.log(`teamsRootDir: ${teamsRootDir}`);
console.log(`hooksDir: ${hooksDir}`);

const leaderEnv = {
	...process.env,
	PI_TEAMS_ROOT_DIR: teamsRootDir,
	PI_TEAMS_HOOKS_ENABLED: "1",
	PI_TEAMS_HOOK_TIMEOUT_MS: "10000",
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
	"--no-tools",
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
let stderr = "";
leader.stderr.on("data", (d: Buffer | string) => {
	stderr += d.toString();
});

const pending = new Map<string, PendingRequest>();
let nextId = 1;

leader.on("close", () => {
	for (const [id, req] of pending.entries()) {
		clearTimeout(req.timeout);
		req.reject(new Error(`Leader closed before response id=${id}. stderr=${stderr}`));
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

	if (isRecord(obj) && obj.type === "extension_ui_request" && obj.method === "notify" && typeof obj.message === "string") {
		const notifyType = typeof obj.notifyType === "string" ? obj.notifyType : "info";
		console.log(`[notify:${notifyType}] ${obj.message}`);
	}
});

const send = async (command: RpcCommand): Promise<RpcResponse> => {
	const id = command.id ?? `req-${nextId++}`;
	leader.stdin.write(JSON.stringify({ ...command, id }) + "\n");

	return await new Promise<RpcResponse>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			reject(new Error(`Timeout waiting for response to ${command.type}. stderr=${stderr}`));
		}, timeoutSec * 1000);
		pending.set(id, { resolve, reject, timeout });
	});
};

try {
	const state = await send({ type: "get_state" });
	if (!state.success) throw new Error(`get_state failed: ${state.error ?? "unknown error"}`);

	const sessionId = extractSessionId(state);
	if (!sessionId) throw new Error(`No sessionId in get_state response: ${JSON.stringify(state)}`);
	const teamId = sessionId;
	const teamDir = path.join(teamsRootDir, teamId);
	const leadName = "team-lead";

	console.log(`teamId: ${teamId}`);
	console.log(`teamDir: ${teamDir}`);

	await waitFor(
		() => fs.existsSync(path.join(teamDir, "config.json")),
		{ timeoutMs: timeoutSec * 1000, pollMs: 100, label: "team config" },
	);

	const policyCfg = await updateTeamHooksPolicy(teamDir, () => ({
		failureAction: "reopen_followup",
		maxReopensPerTask: 2,
		followupOwner: "member",
	}));
	assert(policyCfg !== null, "failed to set team hooks policy");

	const originalTask = await createTask(teamDir, teamId, {
		subject: "Integration gate remediation task",
		description: "Task used by integration-hooks-remediation-test",
		owner: "agent1",
	});

	const completed = await updateTask(teamDir, teamId, originalTask.id, (cur) => {
		const metadata = { ...(cur.metadata ?? {}) };
		metadata.completedAt = new Date().toISOString();
		return { ...cur, status: "completed", metadata };
	});
	assert(completed !== null, "failed to mark original task completed");

	const ts = new Date().toISOString();
	await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
		from: "agent1",
		text: JSON.stringify({
			type: "idle_notification",
			from: "agent1",
			timestamp: ts,
			completedTaskId: originalTask.id,
			completedStatus: "completed",
		}),
		timestamp: ts,
	});

	let followupTaskId = "";

	await waitFor(
		async () => {
			const task = await getTask(teamDir, teamId, originalTask.id);
			if (!task) return false;
			if (task.status !== "pending") return false;
			if (task.metadata?.["qualityGateStatus"] !== "failed") return false;
			if (task.metadata?.["reopenedByQualityGateCount"] !== 1) return false;

			const tasks = await listTasks(teamDir, teamId);
			const followup = findFollowupTask(tasks, originalTask.id);
			if (!followup) return false;
			if (followup.owner !== "agent1") return false;
			followupTaskId = followup.id;
			return true;
		},
		{ timeoutMs: timeoutSec * 1000, pollMs: 200, label: "task reopened + follow-up created" },
	);

	assert(followupTaskId.length > 0, "missing follow-up task id");

	const workerInboxPath = getInboxPath(teamDir, teamId, "agent1");
	await waitFor(
		() => {
			const messages = loadMailboxMessages(workerInboxPath);
			if (messages.length === 0) return false;

			let hasAssignment = false;
			let hasNudge = false;
			for (const msg of messages) {
				const parsed = safeJsonParse(msg.text);
				if (isRecord(parsed) && parsed.type === "task_assignment" && parsed.taskId === followupTaskId) {
					hasAssignment = true;
				}
				if (msg.text.includes("Please remediate automatically and continue without waiting for user intervention.")) {
					hasNudge = true;
				}
			}
			return hasAssignment && hasNudge;
		},
		{ timeoutMs: timeoutSec * 1000, pollMs: 200, label: "follow-up assignment + remediation nudge" },
	);

	assert(fs.existsSync(hookSentinelFile), "hook script did not run");

	const hookLogsDir = path.join(teamDir, "hook-logs");
	await waitFor(
		() => {
			try {
				const files = fs.readdirSync(hookLogsDir, { withFileTypes: true });
				return files.some((f) => f.isFile() && f.name.includes("task_completed"));
			} catch {
				return false;
			}
		},
		{ timeoutMs: timeoutSec * 1000, pollMs: 200, label: "hook log file" },
	);

	console.log("PASS: integration hooks remediation flow passed");
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
