import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TeammateHandle, TeammateStatus } from "./teammate-handle.js";

export type { TeammateStatus } from "./teammate-handle.js";

const MAX_STDERR_CHARS = 128 * 1024;
const MAX_PROTOCOL_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_ASSISTANT_TEXT_CHARS = 64 * 1024;

type RpcCommand =
	| { id: string; type: "prompt"; message: string }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "follow_up"; message: string }
	| { id: string; type: "abort" }
	| { id: string; type: "get_state" }
	| { id: string; type: "set_session_name"; name: string };

type RpcCommandWithoutId = RpcCommand extends infer Command
	? Command extends { id: string }
		? Omit<Command, "id">
		: never
	: never;

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type PendingRequest = {
	resolve: (value: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeParseJsonLine(line: string): unknown | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value) || value.type !== "response") return false;
	return (
		typeof value.command === "string" &&
		typeof value.success === "boolean" &&
		(value.id === undefined || typeof value.id === "string") &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "message_update") {
		const event = value.assistantMessageEvent;
		return isRecord(event) && typeof event.type === "string" &&
			(event.type !== "text_delta" || typeof event.delta === "string");
	}
	if (value.type === "tool_execution_start" || value.type === "tool_execution_update" || value.type === "tool_execution_end") {
		return typeof value.toolCallId === "string" && typeof value.toolName === "string";
	}
	return ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_end"].includes(value.type);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TeammateRpc implements TeammateHandle {
	readonly displayMode = "rpc" as const;
	readonly name: string;
	readonly sessionFile?: string;
	status: TeammateStatus = "starting";
	lastAssistantText = "";
	lastError: string | null = null;
	currentTaskId: string | null = null;
	lastStatusChangeAt = Date.now();
	lastEventAt = Date.now();

	private proc: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<string, PendingRequest>();
	private nextId = 0;
	private buffer = "";
	private stderr = "";
	private eventListeners: Array<(event: AgentEvent) => void> = [];
	private closeListeners: Array<(code: number | null) => void> = [];
	private closed = false;
	private closeCode: number | null = null;
	private stopping = false;

	constructor(name: string, sessionFile?: string) {
		this.name = name;
		this.sessionFile = sessionFile;
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index >= 0) this.eventListeners.splice(index, 1);
		};
	}

	onClose(listener: (code: number | null) => void): () => void {
		if (this.closed) {
			queueMicrotask(() => listener(this.closeCode));
			return () => undefined;
		}
		this.closeListeners.push(listener);
		return () => {
			const index = this.closeListeners.indexOf(listener);
			if (index >= 0) this.closeListeners.splice(index, 1);
		};
	}

	getStderr(): string {
		return this.stderr;
	}

	async start(opts: { cwd: string; env: Record<string, string>; args: string[] }): Promise<void> {
		if (this.proc) throw new Error("Teammate already started");
		this.closed = false;
		this.closeCode = null;
		this.stopping = false;
		const proc = spawn("pi", ["--mode", "rpc", ...opts.args], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.proc = proc;

		proc.on("error", (error) => this.failProcess(`Teammate process error: ${String(error)}`));
		proc.stderr.on("data", (data) => {
			this.stderr = (this.stderr + data.toString()).slice(-MAX_STDERR_CHARS);
		});
		proc.stdout.on("data", (data) => {
			this.buffer += data.toString();
			if (this.buffer.length > MAX_PROTOCOL_BUFFER_CHARS) {
				this.failProcess("Teammate RPC protocol buffer exceeded 4 MiB");
				this.signalProcess(proc, "SIGTERM");
				return;
			}
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.handleLine(line);
			}
		});
		proc.on("close", (code) => this.handleClose(proc, code));

		try {
			await this.send({ type: "get_state" }, 15_000);
		} catch (error) {
			await this.stop();
			throw new Error(`Teammate failed RPC startup handshake: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.setStatus("idle");
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.stopping = true;
		await this.send({ type: "abort" }, 1_000).catch(() => undefined);
		this.signalProcess(proc, "SIGTERM");
		for (let elapsed = 0; elapsed < 2_000 && proc.exitCode === null && proc.signalCode === null; elapsed += 50) await wait(50);
		if (proc.exitCode === null && proc.signalCode === null) this.signalProcess(proc, "SIGKILL");
		this.proc = null;
		this.setStatus("stopped");
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}
	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}
	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}
	async getState(): Promise<unknown> {
		return (await this.send({ type: "get_state" })).data;
	}
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	private setStatus(status: TeammateStatus): void {
		if (this.status !== status) this.lastStatusChangeAt = Date.now();
		this.status = status;
		this.lastEventAt = Date.now();
	}

	private signalProcess(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
			else proc.kill(signal);
		} catch {
			try {
				proc.kill(signal);
			} catch {
				// Process already exited.
			}
		}
	}

	private failProcess(message: string): void {
		this.lastError = message;
		this.setStatus("error");
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(new Error(`${message} (id=${id})`));
		}
		this.pending.clear();
	}

	private handleClose(proc: ChildProcessWithoutNullStreams, code: number | null): void {
		if (this.proc === proc) this.proc = null;
		if (this.stopping || code === 0) this.setStatus("stopped");
		else this.failProcess(`Teammate process exited with code ${code}`);
		if (this.closed) return;
		this.closed = true;
		this.closeCode = code;
		for (const listener of this.closeListeners) listener(code);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		const value = safeParseJsonLine(line);
		if (value === null) return;
		if (isRpcResponse(value)) {
			if (typeof value.id !== "string") return;
			const request = this.pending.get(value.id);
			if (!request) return;
			this.pending.delete(value.id);
			clearTimeout(request.timer);
			if (value.success) request.resolve(value);
			else request.reject(new Error(value.error ?? `${value.command} failed`));
			return;
		}
		if (!isAgentEvent(value)) return;
		const now = Date.now();
		this.lastEventAt = now;
		if (value.type === "agent_start") {
			this.setStatus("streaming");
			this.lastAssistantText = "";
		} else if (value.type === "agent_end") {
			this.setStatus("idle");
		} else if (value.type === "message_update" && value.assistantMessageEvent.type === "text_delta") {
			this.lastAssistantText = (this.lastAssistantText + value.assistantMessageEvent.delta).slice(-MAX_ASSISTANT_TEXT_CHARS);
		}
		for (const listener of this.eventListeners) listener(value);
	}

	private async send(command: RpcCommandWithoutId, timeoutMs = 60_000): Promise<RpcResponse> {
		const proc = this.proc;
		if (!proc?.stdin.writable) throw new Error("Teammate is not running");
		const id = `req-${this.name}-${this.nextId++}`;
		const full = { id, ...command } as RpcCommand;
		const payload = `${JSON.stringify(full)}\n`;

		return await new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`Timeout waiting for response (id=${id}, cmd=${full.type})`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			proc.stdin.write(payload, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new Error(`Failed to write RPC request ${id}: ${error.message}`));
			});
		});
	}
}
