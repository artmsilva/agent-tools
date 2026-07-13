/**
 * pi-live-status
 *
 * Replaces pi's opaque "Working..." line with a live readout of what the agent
 * is actually doing, and (in verbose mode) streams a rolling activity feed in a
 * widget below the editor:
 *
 *   working line:  bash · npm install @tintinweb/pi-subagents · 42s
 *                  thinking · 8s · ~1.2k tok
 *                  2 tools · bash, read · 12s
 *
 *   feed (verbose): ▶ bash  npm install ...
 *                   │ added 4 packages in 5s        <- live tail of tool output
 *                   ✓ bash  5.1s
 *                   ✎ streaming · ~3.4k tok
 *
 * Modes: verbose (default) | line | off — cycle or set via /live-status.
 * Tools running longer than STALL_MS get flagged with an abort/expand hint.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "verbose" | "line" | "off";

const MODES: Mode[] = ["verbose", "line", "off"];
const FEED_MAX = 8;
const TICK_MS = 500;
const STALL_MS = 30_000;
const LINE_MAX = 110;

interface ActiveTool {
	name: string;
	summary: string;
	startedAt: number;
	lastLine?: string;
}

interface FeedEntry {
	at: number;
	kind: "start" | "ok" | "err" | "info" | "tail";
	text: string;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "verbose";
	let running = false;
	let runStartedAt = 0;
	let turnIndex = 0;
	let phase: "thinking" | "writing" | "waiting" = "waiting";
	let streamedChars = 0;
	let outputTokens: number | undefined;
	let toolsCompleted = 0;
	let toolsErrored = 0;
	const activeTools = new Map<string, ActiveTool>();
	const feed: FeedEntry[] = [];
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// ---------- helpers ----------

	const truncate = (s: string, n = LINE_MAX): string => {
		const flat = s.replace(/\s+/g, " ").trim();
		return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
	};

	const fmtElapsed = (ms: number): string => {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	};

	const fmtTokens = (): string | undefined => {
		const approx = outputTokens ?? (streamedChars > 0 ? Math.round(streamedChars / 4) : undefined);
		if (approx === undefined) return undefined;
		return approx >= 1000 ? `~${(approx / 1000).toFixed(1)}k tok` : `~${approx} tok`;
	};

	const summarizeArgs = (toolName: string, args: unknown): string => {
		if (args === null || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		if (typeof a.command === "string") return truncate(a.command, 80);
		if (typeof a.path === "string") return truncate(String(a.path), 80);
		if (typeof a.file_path === "string") return truncate(String(a.file_path), 80);
		if (typeof a.pattern === "string") return truncate(`/${a.pattern}/`, 80);
		if (typeof a.query === "string") return truncate(String(a.query), 80);
		if (typeof a.url === "string" || Array.isArray(a.urls)) {
			return truncate(String(a.url ?? (a.urls as unknown[])[0] ?? ""), 80);
		}
		if (typeof a.description === "string") return truncate(String(a.description), 80);
		if (typeof a.prompt === "string") return truncate(String(a.prompt), 80);
		try {
			return truncate(JSON.stringify(a), 80);
		} catch {
			return "";
		}
	};

	/** Pull the last non-empty text line out of a (partial) tool result. */
	const lastLineOf = (result: unknown): string | undefined => {
		if (result === null || typeof result !== "object") return undefined;
		const content = (result as { content?: unknown }).content;
		if (!Array.isArray(content)) return undefined;
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i] as { type?: string; text?: string };
			if (block?.type === "text" && typeof block.text === "string") {
				const lines = block.text.split("\n").map((l) => l.trim()).filter(Boolean);
				if (lines.length > 0) return truncate(lines[lines.length - 1], 90);
			}
		}
		return undefined;
	};

	const pushFeed = (kind: FeedEntry["kind"], text: string) => {
		feed.push({ at: Date.now(), kind, text: truncate(text) });
		while (feed.length > FEED_MAX) feed.shift();
	};

	// ---------- rendering ----------

	const workingLine = (): string => {
		const now = Date.now();
		const total = fmtElapsed(now - runStartedAt);
		const tok = fmtTokens();

		if (activeTools.size === 1) {
			const [t] = activeTools.values();
			const toolElapsed = now - t.startedAt;
			const stalled = toolElapsed > STALL_MS ? " · Ctrl+O expand / Esc abort" : "";
			const parts = [t.name, t.summary, fmtElapsed(toolElapsed)].filter(Boolean);
			return `${parts.join(" · ")}${stalled}`;
		}
		if (activeTools.size > 1) {
			const names = [...activeTools.values()].map((t) => t.name).join(", ");
			return `${activeTools.size} tools · ${names} · ${total}`;
		}
		const parts: string[] = [phase, total];
		if (tok) parts.push(tok);
		return parts.join(" · ");
	};

	const renderWidget = (ctx: ExtensionContext) => {
		if (mode !== "verbose" || !running) {
			ctx.ui.setWidget("live-status", undefined);
			return;
		}
		const th = ctx.ui.theme;
		const now = Date.now();
		const lines: string[] = [];

		for (const entry of feed) {
			const icon =
				entry.kind === "start" ? th.fg("accent", "▶") :
				entry.kind === "ok" ? th.fg("muted", "✓") :
				entry.kind === "err" ? th.fg("error", "✗") :
				entry.kind === "tail" ? th.fg("dim", "│") :
				th.fg("dim", "·");
			lines.push(`${icon} ${th.fg(entry.kind === "tail" ? "dim" : "muted", entry.text)}`);
		}

		for (const [, t] of activeTools) {
			const elapsed = now - t.startedAt;
			const stalled = elapsed > STALL_MS;
			const head = `⏵ ${t.name} · ${t.summary} · ${fmtElapsed(elapsed)}`;
			lines.push(stalled ? th.fg("error", `${head} · slow — Ctrl+O expand / Esc abort`) : th.fg("accent", head));
			if (t.lastLine) lines.push(`  ${th.fg("dim", `│ ${t.lastLine}`)}`);
		}

		const tok = fmtTokens();
		const summary = [
			`turn ${turnIndex + 1}`,
			`${fmtElapsed(now - runStartedAt)}`,
			`${toolsCompleted} tool${toolsCompleted === 1 ? "" : "s"} done`,
			toolsErrored > 0 ? th.fg("error", `${toolsErrored} failed`) : undefined,
			tok,
		].filter(Boolean).join(" · ");
		lines.push(th.fg("dim", `── live-status · ${summary}`));

		ctx.ui.setWidget("live-status", lines, { placement: "belowEditor" });
	};

	const render = (ctx: ExtensionContext | undefined = lastCtx) => {
		if (!ctx || !ctx.hasUI) return;
		if (mode === "off" || !running) {
			ctx.ui.setWorkingMessage();
			ctx.ui.setWidget("live-status", undefined);
			return;
		}
		ctx.ui.setWorkingMessage(workingLine());
		renderWidget(ctx);
	};

	const startTicker = () => {
		if (ticker) return;
		ticker = setInterval(() => render(), TICK_MS);
	};

	const stopTicker = () => {
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	// ---------- lifecycle ----------

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		running = true;
		runStartedAt = Date.now();
		turnIndex = 0;
		phase = "waiting";
		streamedChars = 0;
		outputTokens = undefined;
		toolsCompleted = 0;
		toolsErrored = 0;
		activeTools.clear();
		feed.length = 0;
		if (ctx.hasUI && mode !== "off") startTicker();
		render(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		running = false;
		stopTicker();
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
		ctx.ui.setWidget("live-status", undefined);
		if (mode !== "off" && runStartedAt > 0) {
			const tok = fmtTokens();
			const summary = [
				`last run ${fmtElapsed(Date.now() - runStartedAt)}`,
				`${turnIndex + 1} turn${turnIndex === 0 ? "" : "s"}`,
				`${toolsCompleted} tool${toolsCompleted === 1 ? "" : "s"}`,
				toolsErrored > 0 ? `${toolsErrored} failed` : undefined,
				tok,
			].filter(Boolean).join(" · ");
			ctx.ui.setStatus("live-status", summary);
		}
	});

	pi.on("turn_start", async (event, ctx) => {
		lastCtx = ctx;
		turnIndex = event.turnIndex;
		phase = "waiting";
		pushFeed("info", `turn ${event.turnIndex + 1} started`);
		render(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		lastCtx = ctx;
		// Detect phase + accumulate streamed size defensively; the stream event
		// shape is provider-dependent, so probe common fields only.
		const ev = event.assistantMessageEvent as
			| { type?: string; delta?: string; text?: string }
			| undefined;
		const type = ev?.type ?? "";
		if (type.includes("thinking") || type.includes("reasoning")) phase = "thinking";
		else if (type.includes("text")) phase = "writing";
		const delta = typeof ev?.delta === "string" ? ev.delta : typeof ev?.text === "string" ? ev.text : "";
		streamedChars += delta.length;
		const usage = (event.message as { usage?: { output?: number } }).usage;
		if (typeof usage?.output === "number" && usage.output > 0) outputTokens = usage.output;
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		lastCtx = ctx;
		const summary = summarizeArgs(event.toolName, event.args);
		activeTools.set(event.toolCallId, {
			name: event.toolName,
			summary,
			startedAt: Date.now(),
		});
		pushFeed("start", `${event.toolName}  ${summary}`);
		render(ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		lastCtx = ctx;
		const tool = activeTools.get(event.toolCallId);
		if (!tool) return;
		const tail = lastLineOf(event.partialResult);
		if (tail && tail !== tool.lastLine) {
			tool.lastLine = tail;
			render(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		lastCtx = ctx;
		const tool = activeTools.get(event.toolCallId);
		activeTools.delete(event.toolCallId);
		const elapsed = tool ? fmtElapsed(Date.now() - tool.startedAt) : "";
		if (event.isError) {
			toolsErrored++;
			const reason = lastLineOf(event.result);
			pushFeed("err", `${event.toolName}  ${elapsed}${reason ? `  ${reason}` : ""}`);
		} else {
			toolsCompleted++;
			const tail = lastLineOf(event.result);
			pushFeed("ok", `${event.toolName}  ${elapsed}${tail ? `  ${tail}` : ""}`);
		}
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
	});

	// ---------- command ----------

	pi.registerCommand("live-status", {
		description: "Cycle or set live-status mode (verbose | line | off)",
		getArgumentCompletions: (prefix: string) => {
			const items = MODES.map((m) => ({ value: m, label: m }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const requested = (args ?? "").trim() as Mode;
			if (MODES.includes(requested)) {
				mode = requested;
			} else {
				mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
			}
			if (mode === "off") {
				ctx.ui.setWorkingMessage();
				ctx.ui.setWidget("live-status", undefined);
				ctx.ui.setStatus("live-status", undefined);
				stopTicker();
			} else if (running && ctx.hasUI) {
				startTicker();
			}
			ctx.ui.notify(`live-status: ${mode}`, "info");
			render(ctx);
		},
	});
}
