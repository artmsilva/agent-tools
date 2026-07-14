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

export default function (pi: ExtensionAPI) {
	const tracker = createStatusTracker();
	let lastCtx: ExtensionContext | undefined;
	let tickHandle: ReturnType<typeof setInterval> | undefined;

	function render(ctx: ExtensionContext) {
		lastCtx = ctx;
		const msg = tracker.message();
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
		ctx.ui.setWorkingMessage(`${ACCENT}${head}${RESET}${extraText}${stallText}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((f) => `${ACCENT}${f}${RESET}`),
			intervalMs: 80,
		});
		render(ctx);
		tickHandle ??= setInterval(() => {
			if (lastCtx) render(lastCtx);
		}, TICK_MS);
	});

	pi.on("session_shutdown", async () => {
		if (tickHandle) clearInterval(tickHandle);
		tickHandle = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		tracker.reset();
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
		render(ctx);
	});
}
