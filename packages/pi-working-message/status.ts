const MAX_DETAIL = 48;

// biome-ignore lint: intentional control-char/ANSI stripping
const UNSAFE_CHARS = /[\x00-\x1f\x7f]|\x1b\[[0-9;]*[a-zA-Z]/g;

function sanitize(text: string): string {
	return text.replace(UNSAFE_CHARS, "");
}

function truncate(text: string, max = MAX_DETAIL): string {
	const oneLine = sanitize(text).replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function shortPath(value: unknown): string | undefined {
	const p = asNonEmptyString(value);
	if (!p) return undefined;
	const clean = sanitize(p);
	const home = process.env.HOME;
	const collapsed = home && clean.startsWith(home) ? `~${clean.slice(home.length)}` : clean;
	const parts = collapsed.split("/");
	return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : collapsed;
}

/** Formats a duration for the working loader. Clamps negative/non-finite input to 0s. */
export function formatElapsed(ms: number): string {
	const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
	const totalSeconds = Math.floor(safeMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export function describeTool(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (toolName) {
		case "bash": {
			const command = asNonEmptyString(a.command);
			return command ? `Running: ${truncate(command)}` : "Running a command…";
		}
		case "read": {
			const path = shortPath(a.path);
			return path ? `Reading ${path}` : "Reading a file…";
		}
		case "edit": {
			const path = shortPath(a.path);
			return path ? `Editing ${path}` : "Editing a file…";
		}
		case "write": {
			const path = shortPath(a.path);
			return path ? `Writing ${path}` : "Writing a file…";
		}
		case "grep":
		case "glob":
		case "find": {
			const query = asNonEmptyString(a.pattern) ?? asNonEmptyString(a.query);
			return query ? `Searching: ${truncate(query)}` : "Searching…";
		}
		case "fetch":
		case "web_fetch": {
			const url = asNonEmptyString(a.url);
			return url ? `Fetching ${truncate(url)}` : "Fetching…";
		}
		default: {
			// MCP tools are named mcp__server__tool — show as "server: tool"
			const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
			if (mcp) return `${mcp[1]}: ${mcp[2]}`;
			return `${toolName}…`;
		}
	}
}

/**
 * Like describeTool, but guarantees it never throws — malformed/hostile
 * args (e.g. a throwing getter from a misbehaving MCP tool) must never
 * crash the working-message loader. Falls back to the bare tool name.
 */
export function safeDescribeTool(toolName: string, args: Record<string, unknown> | undefined): string {
	try {
		return describeTool(toolName, args);
	} catch {
		return `${toolName}…`;
	}
}

export interface StatusTracker {
	/** Model call is in flight, no tokens received yet. */
	waitStart(modelLabel?: string): void;
	/** First token of an assistant response arrived. */
	streamStart(): void;
	/** A subsequent token arrived; resets the idle/stall clock. */
	streamToken(): void;
	start(toolCallId: string, toolName: string, args?: Record<string, unknown>): void;
	end(toolCallId: string): void;
	/** Clears all phase state back to idle (start of a turn, or recovery from stuck/dropped events). */
	reset(): void;
	message(): string;
}

/** Elapsed time before a "no response yet" / "no new tokens" stall warning is shown. */
const STALL_WARNING_MS = 15_000;
const STALL_MARK = " ⚠ stalled?";

type Phase =
	| { kind: "idle" }
	| { kind: "waiting"; since: number; modelLabel?: string }
	| { kind: "streaming"; since: number; lastTokenAt: number };

export function createStatusTracker(options: { now?: () => number } = {}): StatusTracker {
	const now = options.now ?? Date.now;
	const active = new Map<string, { label: string; since: number }>();
	let phase: Phase = { kind: "idle" };

	return {
		waitStart(modelLabel) {
			phase = { kind: "waiting", since: now(), modelLabel };
		},
		streamStart() {
			const t = now();
			phase = { kind: "streaming", since: t, lastTokenAt: t };
		},
		streamToken() {
			if (phase.kind !== "streaming") return; // out-of-order event, ignore
			phase.lastTokenAt = now();
		},
		start(toolCallId, toolName, args) {
			active.set(toolCallId, { label: safeDescribeTool(toolName, args), since: now() });
		},
		end(toolCallId) {
			active.delete(toolCallId);
			// A tool finishing is real, observed progress — not "idle since the last
			// token". Without this, falling back to the streaming phase right after
			// a long tool call (e.g. a slow read) treats the tool's own duration as
			// stalled-idle time and flashes a false " ⚠ stalled?" the instant the
			// tool ends. Refresh the idle clock so only genuine post-tool silence
			// can trigger the warning.
			if (active.size === 0 && phase.kind === "streaming") {
				phase.lastTokenAt = now();
			}
		},
		reset() {
			active.clear();
			phase = { kind: "idle" };
		},
		message() {
			if (active.size > 0) {
				const entries = [...active.values()];
				const latest = entries[entries.length - 1];
				const elapsed = formatElapsed(now() - latest.since);
				const extra = entries.length > 1 ? ` (+${entries.length - 1} more)` : "";
				return `${latest.label} (${elapsed})${extra}`;
			}
			if (phase.kind === "waiting") {
				const elapsedMs = now() - phase.since;
				const target = phase.modelLabel ?? "model";
				const stall = elapsedMs > STALL_WARNING_MS ? STALL_MARK : "";
				return `Waiting for ${target}… (${formatElapsed(elapsedMs)})${stall}`;
			}
			if (phase.kind === "streaming") {
				const elapsedMs = now() - phase.since;
				const idleMs = now() - phase.lastTokenAt;
				const stall = idleMs > STALL_WARNING_MS ? STALL_MARK : "";
				return `Streaming response… (${formatElapsed(elapsedMs)})${stall}`;
			}
			return "Working…";
		},
	};
}
