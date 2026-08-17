import type { TeammateStatus } from "./teammate-handle.js";

export type WatchdogPhase = "checkpoint_sent" | "recovery_requested" | "terminal_requested";

export interface WatchdogState {
	taskId: string;
	phase: WatchdogPhase;
	phaseAt: number;
}

export interface WatchdogConfig {
	stallMs: number;
	graceMs: number;
	livenessMs: number;
	maxRetries: number;
}

export type WatchdogAction = "none" | "checkpoint" | "retry" | "needs_attention" | "runtime_lost";

export interface WatchdogDecision {
	action: WatchdogAction;
	state: WatchdogState | null;
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
	return {
		stallMs: positiveInt(env.PI_TEAMS_STALL_THRESHOLD_MS, 5 * 60_000),
		graceMs: positiveInt(env.PI_TEAMS_STALL_GRACE_MS, 90_000),
		livenessMs: positiveInt(env.PI_TEAMS_MEMBER_STALE_MS, 30_000),
		maxRetries: positiveInt(env.PI_TEAMS_MAX_STALL_RECOVERIES, 1),
	};
}

export function evaluateWatchdog(input: {
	now: number;
	taskId: string | null;
	status: TeammateStatus | undefined;
	lastProgressAt: number | null;
	lastHeartbeatAt: number | null;
	attempts: number;
	state: WatchdogState | null;
	config: WatchdogConfig;
}): WatchdogDecision {
	const { now, taskId, status, lastProgressAt, lastHeartbeatAt, attempts, state, config } = input;
	if (!taskId || status !== "streaming" || lastProgressAt === null) return { action: "none", state: null };
	if (lastHeartbeatAt !== null && now - lastHeartbeatAt > config.livenessMs) {
		return { action: "runtime_lost", state: null };
	}
	if (now - lastProgressAt <= config.stallMs) return { action: "none", state: null };

	if (!state || state.taskId !== taskId) {
		return { action: "checkpoint", state: { taskId, phase: "checkpoint_sent", phaseAt: now } };
	}
	if (state.phase === "terminal_requested") return { action: "none", state };
	if (now - state.phaseAt <= config.graceMs) return { action: "none", state };
	if (state.phase === "checkpoint_sent") {
		if (attempts < config.maxRetries) {
			return { action: "retry", state: { taskId, phase: "recovery_requested", phaseAt: now } };
		}
		return { action: "needs_attention", state: { taskId, phase: "terminal_requested", phaseAt: now } };
	}
	return { action: "needs_attention", state: { taskId, phase: "terminal_requested", phaseAt: now } };
}
