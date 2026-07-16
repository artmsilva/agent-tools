/**
 * pi-duet - instant second opinion from a cheap model
 *
 * Keybinding: alt+u to duet the last user message
 * Command: /duet <text> to duet arbitrary text
 */

import { complete, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { assemblePrompt, resolveDuetModel } from "./helpers.js";

export default function (pi: ExtensionAPI) {
	// Register /duet command
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

	// Register alt+u shortcut (alt+d is built-in deleteWordForward)
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
}

function getLastUserMessage(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
			const textParts = entry.message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text);
			if (textParts.length > 0) return textParts.join("\n");
		}
	}
	return undefined;
}

async function runDuet(prompt: string, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("duet requires interactive mode", "error");
		return;
	}

	const model = resolveDuetModel(ctx.modelRegistry);
	if (!model) {
		ctx.ui.notify("No suitable duet model found. Set DUET_MODEL env var or configure Anthropic/OpenAI.", "error");
		return;
	}

	// Show loader while running
	const startTime = Date.now();
	const result = await ctx.ui.custom<{ text: string; cancelled: boolean }>(
		(tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Duet (${model.id})...`);
			loader.onAbort = () => done({ text: "", cancelled: true });

			const run = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
				}

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: assemblePrompt(ctx.cwd, prompt) }],
					timestamp: Date.now(),
				};

				const response = await complete(
					model,
					{ messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					done({ text: "", cancelled: true });
					return;
				}

				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				done({ text, cancelled: false });
			};

			run().catch((err) => {
				done({ text: `Error: ${err.message}`, cancelled: true });
			});

			return loader;
		},
		{ overlay: true },
	);

	if (result.cancelled && !result.text) {
		ctx.ui.notify("Duet cancelled", "info");
		return;
	}

	const elapsed = Date.now() - startTime;

	// Show result in overlay
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new DuetResultComponent(theme, model, elapsed, result.text, done),
		{ overlay: true },
	);
}

class DuetResultComponent {
	readonly width = 80;
	readonly focused = true;

	constructor(
		private theme: Theme,
		private model: Model<any>,
		private elapsed: number,
		private text: string,
		private done: (result: void) => void,
	) {}

	handleInput(data: string): void {
		// Any key dismisses
		this.done();
	}

	render(_width: number): string[] {
		const th = this.theme;
		const w = this.width;
		const innerW = w - 2;
		const lines: string[] = [];

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		const title = ` ${th.fg("accent", "🤔 Duet")} ${th.fg("dim", `• ${this.model.id} • ${this.elapsed}ms`)}`;
		lines.push(row(title));

		lines.push(row(""));

		// Wrap text into lines
		const contentLines = this.text.split("\n");
		for (const line of contentLines) {
			if (line.length <= innerW - 2) {
				lines.push(row(` ${line}`));
			} else {
				// Simple word wrap
				const words = line.split(" ");
				let current = " ";
				for (const word of words) {
					if (current.length + word.length + 1 <= innerW - 1) {
						current += (current === " " ? "" : " ") + word;
					} else {
						lines.push(row(current));
						current = ` ${word}`;
					}
				}
				if (current.trim()) lines.push(row(current));
			}
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "Press any key to dismiss")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// Simple visible width helper (no ANSI parsing, good enough for this)
function visibleWidth(s: string): number {
	// Remove ANSI escape sequences
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
