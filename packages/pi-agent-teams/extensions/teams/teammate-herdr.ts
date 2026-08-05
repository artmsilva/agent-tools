import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { HerdrClient, HerdrLaunchOptions } from "./herdr-client.js";
import type { TeammateHandle, TeammateStatus } from "./teammate-handle.js";

function readAgentStatus(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const result = (value as Record<string, unknown>).result;
	if (typeof result !== "object" || result === null) return undefined;
	const pane = (result as Record<string, unknown>).pane;
	if (typeof pane !== "object" || pane === null) return undefined;
	const status = (pane as Record<string, unknown>).agent_status;
	return typeof status === "string" ? status : undefined;
}

export class TeammateHerdr implements TeammateHandle {
	readonly displayMode = "herdr" as const;
	readonly name: string;
	readonly sessionFile?: string;
	status: TeammateStatus = "starting";
	lastAssistantText = "";
	lastError: string | null = null;
	currentTaskId: string | null = null;
	lastStatusChangeAt = Date.now();
	lastEventAt = Date.now();

	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private closeListeners: Array<(code: number | null) => void> = [];
	private consecutivePollFailures = 0;
	private consecutiveUnknownStatuses = 0;
	private closed = false;
	private cleaned = false;

	private constructor(
		name: string,
		sessionFile: string | undefined,
		private readonly client: HerdrClient,
		private readonly teamDir: string,
		private readonly paneId: string,
		private readonly agentName: string,
	) {
		this.name = name;
		this.sessionFile = sessionFile;
		this.setStatus("idle");
		this.pollTimer = setInterval(() => void this.poll(), 1_000);
		this.pollTimer.unref?.();
	}

	static async start(
		client: HerdrClient,
		options: HerdrLaunchOptions & { sessionFile?: string },
	): Promise<TeammateHerdr> {
		const launched = await client.launch(options);
		return new TeammateHerdr(options.name, options.sessionFile, client, options.teamDir, launched.paneId, launched.agentName);
	}

	onEvent(_listener: (event: AgentEvent) => void): () => void {
		// Interactive Pi workers persist task progress themselves; Herdr does not expose Pi's RPC event stream.
		return () => undefined;
	}

	onClose(listener: (code: number | null) => void): () => void {
		if (this.closed) {
			queueMicrotask(() => listener(null));
			return () => undefined;
		}
		this.closeListeners.push(listener);
		return () => {
			const index = this.closeListeners.indexOf(listener);
			if (index >= 0) this.closeListeners.splice(index, 1);
		};
	}

	async stop(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		const shouldNotify = !this.closed;
		this.closed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		await this.client.close(this.teamDir, this.name, this.paneId);
		this.setStatus("stopped");
		if (shouldNotify) for (const listener of this.closeListeners) listener(0);
	}

	async prompt(message: string): Promise<void> {
		await this.client.message(this.agentName, message);
	}

	async steer(message: string): Promise<void> {
		await this.client.message(this.agentName, message, true);
	}

	async followUp(message: string): Promise<void> {
		await this.client.message(this.agentName, message);
	}

	async abort(): Promise<void> {
		await this.client.interrupt(this.agentName);
	}

	async getState(): Promise<unknown> {
		return await this.client.paneState(this.paneId);
	}

	async setSessionName(name: string): Promise<void> {
		await this.client.message(this.agentName, `/name ${name}`);
	}

	private setStatus(status: TeammateStatus): void {
		if (this.status !== status) this.lastStatusChangeAt = Date.now();
		this.status = status;
		this.lastEventAt = Date.now();
	}

	private async poll(): Promise<void> {
		if (this.closed) return;
		try {
			const state = await this.client.paneState(this.paneId);
			this.consecutivePollFailures = 0;
			const status = readAgentStatus(state);
			if (status === "working") {
				this.consecutiveUnknownStatuses = 0;
				this.setStatus("streaming");
			} else if (["idle", "ready", "blocked", "done"].includes(status ?? "")) {
				this.consecutiveUnknownStatuses = 0;
				this.setStatus("idle");
			} else if (status === "unknown") {
				this.consecutiveUnknownStatuses += 1;
				if (this.consecutiveUnknownStatuses >= 3) this.handleRuntimeLoss("Herdr pane no longer hosts a Pi agent");
			}
		} catch (error) {
			this.consecutivePollFailures += 1;
			if (this.consecutivePollFailures < 3) return;
			this.handleRuntimeLoss(error instanceof Error ? error.message : String(error));
		}
	}

	private handleRuntimeLoss(message: string): void {
		if (this.closed) return;
		this.lastError = message;
		this.setStatus("error");
		this.closed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		for (const listener of this.closeListeners) listener(null);
	}
}
