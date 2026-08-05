/** Pure helpers for pi-duet and /btw. */

import { getModel, type Message, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Resolve the duet model from DUET_MODEL or a cheap default. */
export function resolveDuetModel(registry: ModelRegistry): Model<any> | undefined {
	const envModel = process.env.DUET_MODEL?.trim();
	if (envModel) {
		const [provider, modelId] = envModel.split("/");
		if (provider && modelId) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	for (const { provider, id } of [
		{ provider: "anthropic", id: "claude-haiku-4" },
		{ provider: "anthropic", id: "claude-3-5-haiku-20241022" },
		{ provider: "openai", id: "gpt-4o-mini" },
	]) {
		const model = getModel(provider, id);
		if (model) return model;
	}

	return undefined;
}

export function assemblePrompt(cwd: string, userMessage: string): string {
	return `You are a second opinion assistant. The user is working in ${cwd} and asked:

${userMessage}

Provide a brief, thoughtful second perspective. Be concise.`;
}

export function buildBtwQuestion(question: string): UserMessage {
	return {
		role: "user",
		content: `Ephemeral /btw side question. Answer briefly using only the prior conversation context. You have no tools and must not call, request, simulate, or output tool calls. Do not continue the main coding task. If the answer is not in the context, say that briefly.\n\nQuestion: ${question}`,
		timestamp: Date.now(),
	};
}

/** Provider replay requires every tool call to have its matching result. */
export function isReplaySafe(messages: Message[]): boolean {
	const pending = new Set<string>();
	const seen = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !block.id) continue;
				pending.add(block.id);
				seen.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!seen.has(message.toolCallId)) return false;
			pending.delete(message.toolCallId);
		}
	}

	return pending.size === 0;
}
