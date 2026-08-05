import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

const execFileAsync = promisify(execFile);
const STATE_FILE = "herdr-runtime.json";

export type TeamDisplayMode = "auto" | "rpc" | "herdr";
export type HerdrRunner = (args: string[]) => Promise<string>;

interface HerdrRuntimeState {
	version: 1;
	workspaceId: string;
	ownedWorkspace: boolean;
	panes: Record<string, string>;
}

export interface HerdrLaunchOptions {
	name: string;
	cwd: string;
	env: Record<string, string>;
	args: string[];
	teamDir: string;
	teamId: string;
}

export interface HerdrLaunchResult {
	paneId: string;
	workspaceId: string;
	agentName: string;
}

export function getTeamDisplayMode(env: NodeJS.ProcessEnv = process.env): TeamDisplayMode {
	const value = env.PI_TEAMS_DISPLAY;
	return value === "rpc" || value === "herdr" ? value : "auto";
}

export const runHerdr: HerdrRunner = async (args) => {
	const { stdout } = await execFileAsync("herdr", args, {
		encoding: "utf8",
		timeout: 65_000,
		maxBuffer: 1024 * 1024,
	});
	return stdout;
};

function parseJson(output: string, context: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(output);
		if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
	} catch {
		// handled below
	}
	throw new Error(`Unexpected herdr ${context} output`);
}

function nestedString(value: Record<string, unknown>, keys: string[]): string | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

function hasHerdrErrorCode(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const value = error as { message?: unknown; stderr?: unknown };
	return `${String(value.message ?? "")} ${String(value.stderr ?? "")}`.includes(code);
}

function isHerdrNotFound(error: unknown): boolean {
	return hasHerdrErrorCode(error, "_not_found");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function statePath(teamDir: string): string {
	return path.join(teamDir, STATE_FILE);
}

async function readState(teamDir: string): Promise<HerdrRuntimeState | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(statePath(teamDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Record<string, unknown>;
		if (value.version !== 1 || typeof value.workspaceId !== "string" || typeof value.ownedWorkspace !== "boolean") return null;
		if (typeof value.panes !== "object" || value.panes === null) return null;
		const panes = Object.fromEntries(
			Object.entries(value.panes).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		return { version: 1, workspaceId: value.workspaceId, ownedWorkspace: value.ownedWorkspace, panes };
	} catch {
		return null;
	}
}

async function writeState(teamDir: string, state: HerdrRuntimeState | null): Promise<void> {
	await fs.promises.mkdir(teamDir, { recursive: true });
	const file = statePath(teamDir);
	if (!state) {
		await fs.promises.rm(file, { force: true });
		return;
	}
	const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.promises.rename(temp, file);
}

function environmentArgs(env: Record<string, string>): string[] {
	return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

export class HerdrClient {
	constructor(
		private readonly runner: HerdrRunner = runHerdr,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	async isAvailable(): Promise<boolean> {
		try {
			await this.runner(["status", "server"]);
			return true;
		} catch {
			return false;
		}
	}

	async launch(options: HerdrLaunchOptions): Promise<HerdrLaunchResult> {
		await fs.promises.mkdir(options.teamDir, { recursive: true });
		const lock = `${statePath(options.teamDir)}.lock`;
		return await withLock(lock, async () => {
			let state = await readState(options.teamDir);
			let paneId: string | undefined;
			let workspaceCreated = false;
			const insideHerdr = this.env.HERDR_ENV === "1" && typeof this.env.HERDR_WORKSPACE_ID === "string";
			const label = `Team: ${options.name}`;
			const envArgs = environmentArgs(options.env);

			try {
				if (insideHerdr) {
					const workspaceId = this.env.HERDR_WORKSPACE_ID;
					if (!workspaceId) throw new Error("HERDR_ENV is set without HERDR_WORKSPACE_ID");
					const output = parseJson(
						await this.runner(["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", options.cwd, "--no-focus", ...envArgs]),
						"tab create",
					);
					paneId = nestedString(output, ["result", "root_pane", "pane_id"]);
					if (!paneId) throw new Error("herdr tab create returned no root pane");
					state = { version: 1, workspaceId, ownedWorkspace: false, panes: { ...(state?.panes ?? {}) } };
				} else {
					if (state) {
						try {
							await this.runner(["workspace", "get", state.workspaceId]);
						} catch {
							state = null;
						}
					}
					if (!state) {
						const output = parseJson(
							await this.runner(["workspace", "create", "--label", `Pi team ${sanitizeName(options.teamId).slice(0, 12)}`, "--cwd", options.cwd, "--no-focus", ...envArgs]),
							"workspace create",
						);
						const workspaceId = nestedString(output, ["result", "workspace", "workspace_id"]);
						paneId = nestedString(output, ["result", "root_pane", "pane_id"]);
						if (!workspaceId || !paneId) throw new Error("herdr workspace create returned incomplete identity");
						state = { version: 1, workspaceId, ownedWorkspace: true, panes: {} };
						workspaceCreated = true;
					} else {
						const output = parseJson(
							await this.runner(["tab", "create", "--workspace", state.workspaceId, "--label", label, "--cwd", options.cwd, "--no-focus", ...envArgs]),
							"tab create",
						);
						paneId = nestedString(output, ["result", "root_pane", "pane_id"]);
						if (!paneId) throw new Error("herdr tab create returned no root pane");
					}
				}

				const agentName = `pi-team-${sanitizeName(options.teamId).slice(0, 12)}-${sanitizeName(options.name)}`;
				state.panes[options.name] = paneId;
				// Persist ownership before the long-running start call so crash recovery can find the pane.
				await writeState(options.teamDir, state);
				for (let attempt = 0; ; attempt += 1) {
					try {
						await this.runner(["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", ...options.args]);
						break;
					} catch (error) {
						if (attempt >= 20 || !hasHerdrErrorCode(error, "agent_pane_busy")) throw error;
						await sleep(500);
					}
				}
				return { paneId, workspaceId: state.workspaceId, agentName };
			} catch (error) {
				let cleaned = true;
				if (paneId) {
					try {
						await this.runner(["pane", "close", paneId]);
					} catch (cleanupError) {
						cleaned = isHerdrNotFound(cleanupError);
					}
				}
				if (cleaned && state && paneId) {
					delete state.panes[options.name];
					if (workspaceCreated) {
						try {
							await this.runner(["workspace", "close", state.workspaceId]);
						} catch (cleanupError) {
							cleaned = isHerdrNotFound(cleanupError);
						}
					}
					if (cleaned) await writeState(options.teamDir, workspaceCreated ? null : state);
				}
				throw error;
			}
		}, { label: `herdr-launch:${options.name}`, timeoutMs: 70_000 });
	}

	async close(teamDir: string, name: string, paneId: string): Promise<void> {
		await fs.promises.mkdir(teamDir, { recursive: true });
		// Preserve runtime state if Herdr is unavailable so a later cleanup can retry.
		try {
			await this.runner(["pane", "close", paneId]);
		} catch (error) {
			if (!isHerdrNotFound(error)) throw error;
		}
		const lock = `${statePath(teamDir)}.lock`;
		await withLock(lock, async () => {
			const state = await readState(teamDir);
			if (!state) return;
			delete state.panes[name];
			if (Object.keys(state.panes).length === 0 && state.ownedWorkspace) {
				try {
					await this.runner(["workspace", "close", state.workspaceId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
				await writeState(teamDir, null);
			} else {
				await writeState(teamDir, state);
			}
		}, { label: `herdr-close:${name}` });
	}

	async cleanupTeam(teamDir: string): Promise<boolean> {
		const file = statePath(teamDir);
		if (!fs.existsSync(file)) return false;
		const lock = `${file}.lock`;
		return await withLock(lock, async () => {
			const state = await readState(teamDir);
			if (!state) throw new Error(`Invalid Herdr runtime state: ${file}`);
			for (const paneId of Object.values(state.panes)) {
				try {
					await this.runner(["pane", "close", paneId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
			}
			if (state.ownedWorkspace) {
				try {
					await this.runner(["workspace", "close", state.workspaceId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
			}
			await writeState(teamDir, null);
			return true;
		}, { label: "herdr-team-cleanup", timeoutMs: 70_000 });
	}

	async paneState(paneId: string): Promise<unknown> {
		return parseJson(await this.runner(["pane", "get", paneId]), "pane get");
	}

	async message(agentName: string, message: string, interrupt = false): Promise<void> {
		if (interrupt) await this.runner(["agent", "send-keys", agentName, "esc"]);
		await this.runner(["agent", "prompt", agentName, message]);
	}

	async interrupt(agentName: string): Promise<void> {
		await this.runner(["agent", "send-keys", agentName, "esc"]);
	}
}
