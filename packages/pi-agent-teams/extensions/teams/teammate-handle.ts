import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type TeammateStatus = "starting" | "idle" | "streaming" | "stopped" | "error";

export interface TeammateHandle {
	readonly name: string;
	readonly sessionFile?: string;
	readonly displayMode: "rpc" | "herdr";
	status: TeammateStatus;
	lastAssistantText: string;
	lastError: string | null;
	currentTaskId: string | null;
	lastStatusChangeAt: number;
	lastEventAt: number;
	onEvent(listener: (event: AgentEvent) => void): () => void;
	onClose(listener: (code: number | null) => void): () => void;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<unknown>;
	setSessionName(name: string): Promise<void>;
}
