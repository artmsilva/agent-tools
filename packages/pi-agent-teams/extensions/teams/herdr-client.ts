import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

const execFileAsync = promisify(execFile);
const STATE_FILE = "herdr-runtime.json";
const GHOSTTY_STATE_FILE = "herdr-ghostty.json";
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;

export type TeamDisplayMode = "auto" | "rpc" | "herdr";
export type HerdrRunner = (args: string[]) => Promise<string>;
export type GhosttyLauncher = (sessionName: string) => Promise<void>;
export type Waiter = (ms: number) => Promise<void>;

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

interface GhosttyRuntimeState {
	version: 1;
	sessionName: string;
	launchedAt: string;
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

export const launchGhosttyHerdr: GhosttyLauncher = async (sessionName) => {
	if (process.platform !== "darwin") throw new Error("Ghostty Herdr bootstrap is only supported on macOS");
	const herdr = process.env.PI_TEAMS_HERDR_BIN ?? "herdr";
	await execFileAsync("open", ["-na", "Ghostty.app", "--args", "-e", herdr, "--session", sessionName], {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
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

function nestedBoolean(value: Record<string, unknown>, keys: string[]): boolean | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "boolean" ? current : undefined;
}

function hasHerdrErrorCode(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const value = error as { message?: unknown; stderr?: unknown };
	return `${String(value.message ?? "")} ${String(value.stderr ?? "")}`.includes(code);
}

function isHerdrNotFound(error: unknown): boolean {
	return hasHerdrErrorCode(error, "_not_found");
}

const sleep: Waiter = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statePath(teamDir: string): string {
	return path.join(teamDir, STATE_FILE);
}

function ghosttyStatePath(teamDir: string): string {
	return path.join(teamDir, GHOSTTY_STATE_FILE);
}

function bootTimeoutMs(env: NodeJS.ProcessEnv): number {
	const parsed = Number.parseInt(env.PI_TEAMS_HERDR_BOOT_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BOOT_TIMEOUT_MS;
}

async function readGhosttyState(teamDir: string): Promise<GhosttyRuntimeState | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(ghosttyStatePath(teamDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Record<string, unknown>;
		if (value.version !== 1 || typeof value.sessionName !== "string" || typeof value.launchedAt !== "string") return null;
		return { version: 1, sessionName: value.sessionName, launchedAt: value.launchedAt };
	} catch {
		return null;
	}
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
	private activeSessionName: string | null = null;

	constructor(
		private readonly runner: HerdrRunner = runHerdr,
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly ghosttyLauncher: GhosttyLauncher = launchGhosttyHerdr,
		private readonly wait: Waiter = sleep,
	) {}

	private invoke(args: string[]): Promise<string> {
		return this.runner(this.activeSessionName ? ["--session", this.activeSessionName, ...args] : args);
	}

	private async stopBootstrappedSession(teamDir: string): Promise<void> {
		const state = await readGhosttyState(teamDir);
		if (!state) return;
		await this.runner(["session", "stop", state.sessionName]);
		await this.runner(["session", "delete", state.sessionName]);
		await fs.promises.rm(ghosttyStatePath(teamDir), { force: true });
		if (this.activeSessionName === state.sessionName) this.activeSessionName = null;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const status = parseJson(await this.invoke(["status", "server", "--json"]), "status server");
			return nestedBoolean(status, ["running"]) === true || nestedString(status, ["status"]) === "running";
		} catch {
			return false;
		}
	}

	async hasVisibleClient(): Promise<boolean> {
		try {
			const status = parseJson(await this.invoke(["status", "client", "--json"]), "status client");
			return nestedString(status, ["session"]) !== undefined;
		} catch {
			return false;
		}
	}

	async ensureVisibleSession(teamDir: string, teamId: string): Promise<void> {
		if (this.env.HERDR_ENV === "1") {
			if (!(await this.isAvailable())) throw new Error("Herdr pane environment is active but its server is unavailable");
			return;
		}
		await fs.promises.mkdir(teamDir, { recursive: true });
		const recovered = await readGhosttyState(teamDir);
		this.activeSessionName = recovered?.sessionName ?? null;
		if ((await this.isAvailable()) && (await this.hasVisibleClient())) return;

		const file = ghosttyStatePath(teamDir);
		await withLock(`${file}.lock`, async () => {
			if ((await this.isAvailable()) && (await this.hasVisibleClient())) return;
			const sessionName = recovered?.sessionName ?? `pi-team-${sanitizeName(teamId).slice(0, 24)}`;
			this.activeSessionName = sessionName;
			await this.ghosttyLauncher(sessionName);
			const deadline = Date.now() + bootTimeoutMs(this.env);
			while (Date.now() < deadline) {
				if ((await this.isAvailable()) && (await this.hasVisibleClient())) {
					const state: GhosttyRuntimeState = { version: 1, sessionName, launchedAt: new Date().toISOString() };
					await fs.promises.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
					return;
				}
				await this.wait(250);
			}
			throw new Error(`Timed out waiting for visible Herdr session '${sessionName}'`);
		}, { label: "herdr-ghostty-bootstrap", timeoutMs: bootTimeoutMs(this.env) + 5_000 });
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
						await this.invoke(["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", options.cwd, "--no-focus", ...envArgs]),
						"tab create",
					);
					paneId = nestedString(output, ["result", "root_pane", "pane_id"]);
					if (!paneId) throw new Error("herdr tab create returned no root pane");
					state = { version: 1, workspaceId, ownedWorkspace: false, panes: { ...(state?.panes ?? {}) } };
				} else {
					if (state) {
						try {
							await this.invoke(["workspace", "get", state.workspaceId]);
						} catch {
							state = null;
						}
					}
					if (!state) {
						const output = parseJson(
							await this.invoke(["workspace", "create", "--label", `Pi team ${sanitizeName(options.teamId).slice(0, 12)}`, "--cwd", options.cwd, "--no-focus", ...envArgs]),
							"workspace create",
						);
						const workspaceId = nestedString(output, ["result", "workspace", "workspace_id"]);
						paneId = nestedString(output, ["result", "root_pane", "pane_id"]);
						if (!workspaceId || !paneId) throw new Error("herdr workspace create returned incomplete identity");
						state = { version: 1, workspaceId, ownedWorkspace: true, panes: {} };
						workspaceCreated = true;
					} else {
						const output = parseJson(
							await this.invoke(["tab", "create", "--workspace", state.workspaceId, "--label", label, "--cwd", options.cwd, "--no-focus", ...envArgs]),
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
						await this.invoke(["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", ...options.args]);
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
						await this.invoke(["pane", "close", paneId]);
					} catch (cleanupError) {
						cleaned = isHerdrNotFound(cleanupError);
					}
				}
				if (cleaned && state && paneId) {
					delete state.panes[options.name];
					if (workspaceCreated) {
						try {
							await this.invoke(["workspace", "close", state.workspaceId]);
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
			await this.invoke(["pane", "close", paneId]);
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
					await this.invoke(["workspace", "close", state.workspaceId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
				await writeState(teamDir, null);
				await this.stopBootstrappedSession(teamDir);
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
			const ghosttyState = await readGhosttyState(teamDir);
			if (ghosttyState) this.activeSessionName = ghosttyState.sessionName;
			for (const paneId of Object.values(state.panes)) {
				try {
					await this.invoke(["pane", "close", paneId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
			}
			if (state.ownedWorkspace) {
				try {
					await this.invoke(["workspace", "close", state.workspaceId]);
				} catch (error) {
					if (!isHerdrNotFound(error)) throw error;
				}
			}
			await writeState(teamDir, null);
			await this.stopBootstrappedSession(teamDir);
			return true;
		}, { label: "herdr-team-cleanup", timeoutMs: 70_000 });
	}

	async paneState(paneId: string): Promise<unknown> {
		return parseJson(await this.invoke(["pane", "get", paneId]), "pane get");
	}

	async readAgent(agentName: string, lines = 80): Promise<string> {
		return await this.invoke(["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"]);
	}

	async message(agentName: string, message: string, interrupt = false): Promise<void> {
		if (interrupt) await this.invoke(["agent", "send-keys", agentName, "esc"]);
		await this.invoke(["agent", "prompt", agentName, message]);
	}

	async interrupt(agentName: string): Promise<void> {
		await this.invoke(["agent", "send-keys", agentName, "esc"]);
	}
}
