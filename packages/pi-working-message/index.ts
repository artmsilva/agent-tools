/**
 * Custom working loader — animated spinner + a live, phase-aware status.
 *
 * Never shows "Thinking...". Instead:
 * - "Waiting for <provider>/<model>… (Ns)"  — model call sent, no tokens yet
 * - "Streaming response… (Ns)"              — tokens arriving
 * - "Reading src/foo.ts (Ns)"               — tool executing
 * - a " ⚠ stalled?" suffix appears once a phase sits idle past ~15s, so you
 *   can tell "slow but alive" from "actually frozen" instead of guessing.
 *
 * A background tick (every 500ms) keeps the elapsed counter live even when
 * no events arrive at all — that's the actual signal for a real stall.
 *
 * The status text also fades from blue toward red as a phase sits idle — a
 * reversible ramp inspired by pi-claude-shimmer's frame counter, so a slowing
 * turn escalates smoothly *before* the hard ` ⚠ stalled?` marker snaps on, and
 * cools back to blue once a token arrives. status.ts owns only the pure,
 * unit-tested predicate `isStalling()`; the ramp itself is accumulated here on
 * the fixed tick (never the wall clock, never per-event) so its speed is
 * deterministic and a clock jump can't flash it to full red.
 *
 * Status formatting/timing logic (including sad-path handling) lives in
 * ./status.ts and is covered by ./status.test.ts (`bun test`).
 *
 * Edit colors/timing below, or thresholds/labels in status.ts, then /reload.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStatusTracker } from "./status";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACCENT = "\x1b[38;2;155;186;255m"; // soft blue
const WARN = "\x1b[38;2;255;179;71m"; // amber, reserved for the stall warning
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const TICK_MS = 500;

// Stall color ramp: the status head lerps from ACCENT (healthy) to STALL_RGB
// (fully stalled) as `displayedStall` climbs 0→1.
const ACCENT_RGB: [number, number, number] = [155, 186, 255];
const STALL_RGB: [number, number, number] = [230, 90, 95];
// Fraction of the remaining gap the ramp closes per tick. Applied once per
// fixed TICK_MS (not per render/event), so the fade in/out runs at a constant,
// event-rate-independent speed — ~5 ticks (2.5s) to look fully warmed/cooled.
const STALL_EASE = 0.4;

function blendRgb(
	a: [number, number, number],
	b: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

function fg([r, g, b]: [number, number, number]): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

export default function (pi: ExtensionAPI) {
	const tracker = createStatusTracker();
	let lastCtx: ExtensionContext | undefined;
	let tickHandle: ReturnType<typeof setInterval> | undefined;
	// Displayed (eased) stall intensity, chases tracker.stallLevel() each render.
	let displayedStall = 0;

	// Advances `displayedStall` one easing step toward the current target. Called
	// only from the fixed tick so the ramp cadence is stable and decoupled from
	// how fast events arrive.
	function stepStallRamp() {
		const target = tracker.isStalling() ? 1 : 0;
		displayedStall += (target - displayedStall) * STALL_EASE;
		if (Math.abs(target - displayedStall) < 0.01) displayedStall = target;
	}

	function render(ctx: ExtensionContext) {
		lastCtx = ctx;
		const msg = tracker.message();
		const headColor = displayedStall > 0 ? fg(blendRgb(ACCENT_RGB, STALL_RGB, displayedStall)) : ACCENT;
		// Split off a trailing " ⚠ ..." stall marker so it stays a clear, solid
		// amber warning.
		const match = /^(.*?)( ⚠.*)?$/.exec(msg);
		const primary = match?.[1] ?? msg;
		const stall = match?.[2] ?? "";
		const stallText = stall ? `${WARN}${stall}${RESET}` : "";
		// Split off a trailing " (+N more)" suffix and keep it dim.
		const extraMatch = /^(.*?)( \(\+\d+ more\))$/.exec(primary);
		const head = extraMatch?.[1] ?? primary;
		const extra = extraMatch?.[2] ?? "";
		const extraText = extra ? `${DIM}${extra}${RESET}` : "";
		ctx.ui.setWorkingMessage(`${headColor}${head}${RESET}${extraText}${stallText}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((f) => `${ACCENT}${f}${RESET}`),
			intervalMs: 80,
		});
		render(ctx);
		tickHandle ??= setInterval(() => {
			stepStallRamp();
			if (!lastCtx) return;
			try {
				render(lastCtx);
			} catch {
				// ponytail: ctx went stale (newSession/fork/switchSession/reload).
				// Drop it; the next event delivers a fresh ctx and rendering resumes.
				lastCtx = undefined;
			}
		}, TICK_MS);
	});

	pi.on("session_shutdown", async () => {
		if (tickHandle) clearInterval(tickHandle);
		tickHandle = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		tracker.reset();
		displayedStall = 0; // start each turn cool, no leftover red tint
		render(ctx);
	});

	// Fires right before each LLM call — the model has been asked, no tokens yet.
	pi.on("context", async (_event, ctx) => {
		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		tracker.waitStart(modelLabel);
		render(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") {
			tracker.streamStart();
			render(ctx);
		}
	});

	pi.on("message_update", async (_event, ctx) => {
		tracker.streamToken();
		render(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			tracker.start(event.toolCallId, event.toolName, event.args as Record<string, unknown>);
		} finally {
			render(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		tracker.end(event.toolCallId);
		render(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		tracker.reset();
		displayedStall = 0;
		render(ctx);
	});
}
