/**
 * Slack Remote Control for Pi  (thread-per-session)
 * =================================================
 *
 * Drive one or many Pi sessions from a Slack DM with your Slack bot.
 *
 * Each session anchors itself to its OWN Slack thread:
 *   - On start it posts a root DM  `🟢 [label] connected` and owns that thread.
 *   - Turn-done summaries post inside that thread.
 *   - You **reply in a session's thread** to drive THAT session:
 *       * idle  -> new turn
 *       * busy  -> steers the current turn (interrupt)
 *       * `>>…` -> queued as a follow-up
 *       * `/stop` / `/abort` -> abort that session's turn
 *       * `/status` -> that session reports busy/idle in-thread
 *   - Bot reacts 👀 in-thread the moment a reply is picked up.
 *
 * Top-level DMs (not in any thread) are BROADCAST control only:
 *   `/stop` aborts every running session. Arbitrary top-level text is ignored
 *   (reply inside a thread to target a session).
 *
 * Required bot token scopes: chat:write, reactions:write, im:write, im:read,
 * im:history. Enable the App Home "Messages Tab" and allow users to send
 * messages to the app so you can DM it back.
 *
 * Env:
 *   SLACK_BOT_TOKEN   (required) xoxb bot token
 *   PI_SLACK_USER_ID  (your Slack user id to DM; required unless SLACK_USER_TOKEN is set)
 *   SLACK_USER_TOKEN  (optional) xoxp token, used only to auto-detect your user id
 *   PI_SLACK_POLL_MS  (optional) poll interval ms (default 3000, min 1000)
 *   PI_SLACK_REMOTE   (optional) "off" to start disabled
 */

import { createConnection } from "node:net";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const USER_TOKEN = process.env.SLACK_USER_TOKEN ?? "";
const POLL_MS = Math.max(1000, Number(process.env.PI_SLACK_POLL_MS ?? 3000));
const MAX_NOTIFY_CHARS = 1500;

type SlackResp = Record<string, unknown> & { ok: boolean; error?: string };

async function slack(
	method: string,
	params: Record<string, string | number | boolean> = {},
	opts: { get?: boolean } = {},
): Promise<SlackResp> {
	const url = `https://slack.com/api/${method}`;
	const headers: Record<string, string> = { Authorization: `Bearer ${BOT_TOKEN}` };
	let res: Response;
	if (opts.get) {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
		res = await fetch(`${url}?${qs.toString()}`, { headers });
	} else {
		headers["Content-Type"] = "application/json; charset=utf-8";
		res = await fetch(url, { method: "POST", headers, body: JSON.stringify(params) });
	}
	return (await res.json()) as SlackResp;
}

interface SlackMessage {
	type?: string;
	subtype?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
}

// ── Runtime state (one Pi process = one session) ────────────────────────────
let enabled = process.env.PI_SLACK_REMOTE !== "off";
let botUserId = "";
let myUserId = process.env.PI_SLACK_USER_ID ?? "";
let dmChannel = "";
let threadTs = ""; // this session's anchor thread
let replyLastTs = ""; // newest in-thread reply consumed
let bcastLastTs = ""; // newest top-level broadcast consumed
let label = "pi";
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let lastAssistantText = "";
let piRef: ExtensionAPI | undefined;
let uiRef: ExtensionContext | undefined;

function status(text: string) {
	if (uiRef?.hasUI) uiRef.ui.setStatus("slack-remote", text);
}

function stripMrkdwn(t: string): string {
	return t
		.replace(/<@([UW][A-Z0-9]+)>/g, "@$1")
		.replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, "#$1")
		.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
		.replace(/<(https?:[^>]+)>/g, "$1")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

async function post(text: string, inThread = true): Promise<string | undefined> {
	if (!dmChannel) return;
	const params: Record<string, string | boolean> = {
		channel: dmChannel,
		text,
		unfurl_links: false,
	};
	if (inThread && threadTs) params.thread_ts = threadTs;
	try {
		const r = await slack("chat.postMessage", params);
		return r.ok ? String(r.ts ?? "") : undefined;
	} catch {
		return undefined;
	}
}

async function react(ts: string, name: string): Promise<void> {
	if (!dmChannel) return;
	try {
		await slack("reactions.add", { channel: dmChannel, timestamp: ts, name });
	} catch {
		/* optional */
	}
}

async function resolveIdentity(): Promise<boolean> {
	const auth = await slack("auth.test");
	if (!auth.ok) {
		status(`slack: auth failed (${auth.error})`);
		return false;
	}
	botUserId = String(auth.user_id ?? "");

	if (!myUserId && USER_TOKEN) {
		try {
			const res = await fetch("https://slack.com/api/auth.test", {
				headers: { Authorization: `Bearer ${USER_TOKEN}` },
			});
			const j = (await res.json()) as SlackResp;
			if (j.ok) myUserId = String(j.user_id ?? "");
		} catch {
			/* fall through */
		}
	}
	if (!myUserId) {
		status("slack: set PI_SLACK_USER_ID (or SLACK_USER_TOKEN) — disabled");
		return false;
	}

	const open = await slack("conversations.open", { users: myUserId });
	if (!open.ok) {
		status(`slack: conversations.open failed (${open.error})`);
		return false;
	}
	dmChannel = String((open.channel as { id?: string } | undefined)?.id ?? "");
	return Boolean(dmChannel);
}

// ── Herdr integration: use workspace/tab names for the thread label ─────────
// Herdr (terminal workspace manager) exposes friendly space/tab names over a
// unix socket. When running inside a herdr pane, prefer `workspace / tab` as
// the label so Slack threads read like your actual terminal layout.
function herdrCall<T>(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	pick: (resp: Record<string, unknown>) => T | undefined,
	timeoutMs = 800,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		let done = false;
		let buf = "";
		const finish = (v: T | undefined) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(v);
		};
		const socket = createConnection(socketPath);
		socket.on("error", () => finish(undefined));
		socket.on("connect", () =>
			socket.write(`${JSON.stringify({ id: `slack-remote:${method}`, method, params })}\n`),
		);
		socket.on("data", (d) => {
			buf += d.toString();
			try {
				const resp = JSON.parse(buf.trim()) as Record<string, unknown>;
				finish(pick(resp));
			} catch {
				/* wait for more data */
			}
		});
		const t = setTimeout(() => finish(undefined), timeoutMs);
		t.unref?.();
	});
}

async function herdrLabel(): Promise<string | undefined> {
	if (process.env.HERDR_ENV !== "1") return undefined;
	const sock = process.env.HERDR_SOCKET_PATH;
	if (!sock) return undefined;
	const ws = process.env.HERDR_WORKSPACE_ID;
	const tab = process.env.HERDR_TAB_ID;
	const pane = process.env.HERDR_PANE_ID;

	const wsLabel = ws
		? await herdrCall(sock, "workspace.get", { workspace_id: ws }, (r) => {
				const w = (r.result as { workspace?: { label?: string } } | undefined)?.workspace;
				return w?.label;
			})
		: undefined;
	const tabLabel = tab
		? await herdrCall(sock, "tab.get", { tab_id: tab }, (r) => {
				const t = (r.result as { tab?: { label?: string } } | undefined)?.tab;
				return t?.label;
			})
		: undefined;

	const parts = [wsLabel, tabLabel].filter((s): s is string => Boolean(s && s.trim()));
	if (parts.length === 0) return undefined;
	// Disambiguate multiple panes in the same tab (e.g. "p1", "p2").
	const paneToken = pane?.split(":").pop();
	const base = parts.join(" / ");
	return paneToken ? `${base} ·${paneToken}` : base;
}

async function computeLabel(ctx: ExtensionContext): Promise<string> {
	const herdr = await herdrLabel();
	if (herdr) return herdr;

	const sm = ctx.sessionManager;
	let name: string | undefined;
	try {
		name = sm.getSessionName();
	} catch {
		/* ignore */
	}
	const base = name || basename(ctx.cwd || "pi") || "pi";
	let shortId = "";
	try {
		shortId = (sm.getSessionId() || "").slice(-4);
	} catch {
		/* ignore */
	}
	return shortId ? `${base}·${shortId}` : base;
}

async function anchorThread(ctx: ExtensionContext): Promise<boolean> {
	label = await computeLabel(ctx);
	const ts = await post(`🟢 *${label}* connected\n\`${ctx.cwd}\`\nReply in this thread to drive this session.`, false);
	if (!ts) {
		status("slack: could not post thread anchor");
		return false;
	}
	threadTs = ts;
	replyLastTs = ts;
	bcastLastTs = (Date.now() / 1000).toFixed(6);
	return true;
}

function inject(text: string): string {
	if (!piRef || !uiRef) return "dropped";
	if (uiRef.isIdle()) {
		piRef.sendUserMessage(text);
		return "new turn";
	}
	if (text.startsWith(">>")) {
		piRef.sendUserMessage(text.slice(2).trim(), { deliverAs: "followUp" });
		return "follow-up";
	}
	piRef.sendUserMessage(text, { deliverAs: "steer" });
	return "steer";
}

/** Returns true if the text was a control verb and was handled. */
async function handleControl(raw: string, ts: string, threaded: boolean): Promise<boolean> {
	if (/^\/?(stop|abort)$/i.test(raw)) {
		uiRef?.abort();
		await react(ts, "octagonal_sign");
		return true;
	}
	if (threaded && /^\/?status$/i.test(raw)) {
		const busy = uiRef && !uiRef.isIdle();
		await post(busy ? `⏳ *${label}* is working.` : `✅ *${label}* is idle, waiting.`);
		await react(ts, "eyes");
		return true;
	}
	return false;
}

async function poll(): Promise<void> {
	if (!enabled || polling || !dmChannel || !threadTs) return;
	polling = true;
	try {
		// 1) In-thread replies -> target THIS session.
		const rep = await slack(
			"conversations.replies",
			{ channel: dmChannel, ts: threadTs, oldest: replyLastTs, inclusive: false, limit: 30 },
			{ get: true },
		);
		if (rep.ok) {
			const msgs = ((rep.messages as SlackMessage[]) ?? [])
				.filter((m) => m.ts && Number(m.ts) > Number(replyLastTs))
				.filter((m) => m.user === myUserId && !m.bot_id && !m.subtype)
				.sort((a, b) => Number(a.ts) - Number(b.ts));
			for (const m of msgs) {
				replyLastTs = m.ts as string;
				const raw = stripMrkdwn(m.text ?? "");
				if (!raw) continue;
				if (await handleControl(raw, m.ts as string, true)) continue;
				await react(m.ts as string, "eyes");
				status(`slack: ${inject(raw)} <- [${label}]`);
			}
		} else {
			status(`slack: replies error (${rep.error})`);
		}

		// 2) Top-level broadcast control (e.g. /stop everyone).
		const hist = await slack(
			"conversations.history",
			{ channel: dmChannel, oldest: bcastLastTs, inclusive: false, limit: 20 },
			{ get: true },
		);
		if (hist.ok) {
			const tops = ((hist.messages as SlackMessage[]) ?? [])
				.filter((m) => m.ts && Number(m.ts) > Number(bcastLastTs))
				.filter((m) => m.user === myUserId && !m.bot_id && !m.subtype && !m.thread_ts)
				.sort((a, b) => Number(a.ts) - Number(b.ts));
			for (const m of tops) {
				bcastLastTs = m.ts as string;
				const raw = stripMrkdwn(m.text ?? "");
				// Only broadcast control verbs; ignore arbitrary top-level text.
				await handleControl(raw, m.ts as string, false);
			}
		}
	} catch (err) {
		status(`slack: poll failed (${(err as Error).message})`);
	} finally {
		polling = false;
	}
}

function start(): void {
	if (timer) clearInterval(timer);
	timer = setInterval(() => void poll(), POLL_MS);
	if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();
}

function stop(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
}

export default function (pi: ExtensionAPI) {
	piRef = pi;

	pi.on("session_start", async (_event, ctx) => {
		uiRef = ctx;
		threadTs = "";
		if (!BOT_TOKEN) {
			status("slack: SLACK_BOT_TOKEN not set — disabled");
			return;
		}
		if (!(await resolveIdentity())) return;
		if (!enabled) {
			status("slack: off");
			return;
		}
		if (!(await anchorThread(ctx))) return;
		start();
		status(`slack: on [${label}]`);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		uiRef = ctx;
		if (!enabled || !dmChannel || !threadTs) return;
		// Keep the label fresh if the herdr workspace/tab was renamed mid-session.
		const refreshed = await herdrLabel();
		if (refreshed) label = refreshed;
		const body = lastAssistantText ? stripMrkdwn(lastAssistantText) : "(no text output)";
		const trimmed = body.length > MAX_NOTIFY_CHARS ? `${body.slice(0, MAX_NOTIFY_CHARS)}…` : body;
		await post(`✅ *${label}* turn done\n${trimmed}`);
		status(`slack: on [${label}] idle`);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const text = event.message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (text) lastAssistantText = text;
	});

	pi.on("session_shutdown", async () => {
		if (enabled && threadTs) await post(`🔴 *${label}* disconnected`);
		stop();
	});

	pi.registerCommand("slack", {
		description: "Slack remote: on | off | status | test",
		handler: async (args, ctx) => {
			uiRef = ctx;
			const cmd = args.trim().toLowerCase();
			if (cmd === "off") {
				enabled = false;
				stop();
				if (threadTs) await post(`⚪️ *${label}* remote disabled`);
				ctx.ui.notify("Slack remote disabled", "info");
				status("slack: off");
				return;
			}
			if (cmd === "on" || cmd === "") {
				if (!BOT_TOKEN) {
					ctx.ui.notify("SLACK_BOT_TOKEN not set", "error");
					return;
				}
				enabled = true;
				if (!dmChannel && !(await resolveIdentity())) {
					ctx.ui.notify("Slack auth failed", "error");
					return;
				}
				if (!threadTs && !(await anchorThread(ctx))) {
					ctx.ui.notify("Could not anchor Slack thread", "error");
					return;
				}
				start();
				ctx.ui.notify(`Slack remote enabled [${label}]`, "info");
				status(`slack: on [${label}]`);
				return;
			}
			if (cmd === "test") {
				await post("🔔 Test ping.");
				ctx.ui.notify(threadTs ? "Sent test to thread" : "No thread yet", "info");
				return;
			}
			if (cmd === "status") {
				ctx.ui.notify(
					`enabled=${enabled} label=${label} dm=${dmChannel || "none"} thread=${threadTs || "none"}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /slack on|off|status|test", "warning");
		},
	});
}
