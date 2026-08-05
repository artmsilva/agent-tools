/**
 * pi-duet — cheap second opinions plus ephemeral /btw side questions.
 *
 * /duet sends one prompt to a cheap model.
 * /btw asks the current model about the existing session without tools or history writes.
 */

import {
	complete,
	type Context as LlmContext,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { assemblePrompt, buildBtwQuestion, isReplaySafe, resolveDuetModel } from "./helpers.js";

export default function (pi: ExtensionAPI) {
	let latestProviderMessages: Message[] = [];
	let latestSystemPrompt = "";

	pi.on("before_agent_start", async (event) => {
		latestSystemPrompt = event.systemPrompt;
	});

	pi.on("context", async (event) => {
		latestProviderMessages = convertToLlm(event.messages);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestProviderMessages = [];
		latestSystemPrompt = ctx.getSystemPrompt() || "";
	});

	pi.registerCommand("duet", {
		description: "Get a second opinion from a cheap model",
		handler: async (args, ctx) => {
			const prompt = args.trim() || getLastUserMessage(ctx);
			if (!prompt) {
				ctx.ui.notify("No prompt to duet (provide text or have a message in history)", "warning");
				return;
			}
			await runDuet(prompt, ctx);
		},
	});

	pi.registerShortcut("alt+u", {
		description: "Duet the last user message",
		handler: async (ctx) => {
			const prompt = getLastUserMessage(ctx);
			if (!prompt) {
				ctx.ui.notify("No user message to duet", "warning");
				return;
			}
			await runDuet(prompt, ctx);
		},
	});

	pi.registerCommand("btw", {
		description: "Ask an ephemeral, tool-free side question about this session",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}
			await runBtw(question, ctx, latestProviderMessages, latestSystemPrompt);
		},
	});
}

function getLastUserMessage(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
			const text = entry.message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return undefined;
}

function getSessionMessages(ctx: ExtensionContext): Message[] {
	try {
		const session = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		return convertToLlm(session.messages);
	} catch {
		return [];
	}
}

function chooseBtwMessages(ctx: ExtensionContext, providerMessages: Message[]): Message[] | undefined {
	const sessionMessages = getSessionMessages(ctx);
	const candidates = ctx.isIdle()
		? [sessionMessages, providerMessages]
		: [providerMessages, sessionMessages];
	return candidates.find((messages) => messages.length > 0 && isReplaySafe(messages));
}

async function runDuet(prompt: string, ctx: ExtensionContext): Promise<void> {
	const model = resolveDuetModel(ctx.modelRegistry);
	if (!model) {
		ctx.ui.notify("No suitable duet model found. Set DUET_MODEL or configure Anthropic/OpenAI.", "error");
		return;
	}

	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: assemblePrompt(ctx.cwd, prompt) }],
		timestamp: Date.now(),
	};
	await runSideCall("Duet", model, { messages: [message] }, ctx);
}

async function runBtw(
	question: string,
	ctx: ExtensionContext,
	providerMessages: Message[],
	systemPrompt: string,
): Promise<void> {
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const messages = chooseBtwMessages(ctx, providerMessages);
	if (!messages) {
		ctx.ui.notify("The session is between a tool call and its result. Try /btw again in a moment.", "warning");
		return;
	}

	await runSideCall(
		"BTW",
		ctx.model,
		{
			systemPrompt: systemPrompt || ctx.getSystemPrompt(),
			messages: [...messages, buildBtwQuestion(question)],
			tools: [],
		},
		ctx,
		{ sessionId: ctx.sessionManager.getSessionId(), cacheRetention: "short", maxTokens: 1_000 },
	);
}

async function runSideCall(
	title: string,
	model: Model<any>,
	context: LlmContext,
	ctx: ExtensionContext,
	extraOptions: Record<string, unknown> = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title.toLowerCase()} requires interactive mode`, "error");
		return;
	}

	const startedAt = Date.now();
	const result = await ctx.ui.custom<{ text: string; cancelled: boolean }>(
		(tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, `${title} (${model.id})...`);
			loader.onAbort = () => done({ text: "", cancelled: true });

			(async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
				}

				const response = await complete(model, context, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: loader.signal,
					...extraOptions,
				});

				if (response.stopReason === "aborted") {
					done({ text: "", cancelled: true });
					return;
				}

				const text = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				done({ text: text || "No answer returned.", cancelled: false });
			})().catch((error: unknown) => {
				done({ text: `Error: ${error instanceof Error ? error.message : String(error)}`, cancelled: false });
			});

			return loader;
		},
		{ overlay: true },
	);

	if (result.cancelled) {
		ctx.ui.notify(`${title} cancelled`, "info");
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) =>
			new SideResultComponent(theme, title, model, Date.now() - startedAt, result.text, done),
		{ overlay: true },
	);
}

class SideResultComponent {
	readonly width = 80;
	readonly focused = true;

	constructor(
		private theme: Theme,
		private title: string,
		private model: Model<any>,
		private elapsed: number,
		private text: string,
		private done: () => void,
	) {}

	handleInput(): void {
		this.done();
	}

	render(): string[] {
		const innerWidth = this.width - 2;
		const row = (text: string) =>
			this.theme.fg("border", "│") + padVisible(text, innerWidth) + this.theme.fg("border", "│");
		const lines = [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			row(` ${this.theme.fg("accent", this.title)} ${this.theme.fg("dim", `• ${this.model.id} • ${this.elapsed}ms`)}`),
			row(""),
		];

		for (const paragraph of this.text.split("\n")) {
			for (const line of wrapVisible(paragraph, innerWidth - 2)) lines.push(row(` ${line}`));
		}

		lines.push(row(""), row(` ${this.theme.fg("dim", "Press any key to dismiss")}`));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

function wrapVisible(text: string, width: number): string[] {
	if (!text) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/)) {
		if (current && current.length + word.length + 1 > width) {
			lines.push(current);
			current = word;
		} else {
			current += `${current ? " " : ""}${word}`;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function padVisible(text: string, width: number): string {
	const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
	return text + " ".repeat(Math.max(0, width - visible));
}
