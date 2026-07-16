/**
 * Pure helper functions for pi-duet
 */

import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Resolve the duet model from DUET_MODEL env var or default to a cheap model.
 * Format: "provider/modelId" e.g. "anthropic/claude-haiku-4" or "openai/gpt-4o-mini"
 */
export function resolveDuetModel(registry: ModelRegistry): Model<any> | undefined {
	const envModel = process.env.DUET_MODEL?.trim();
	if (envModel) {
		const [provider, modelId] = envModel.split("/");
		if (provider && modelId) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// Default: try haiku-4, then haiku-3.5, then gpt-4o-mini
	const defaults = [
		{ provider: "anthropic", id: "claude-haiku-4" },
		{ provider: "anthropic", id: "claude-3-5-haiku-20241022" },
		{ provider: "openai", id: "gpt-4o-mini" },
	];

	for (const { provider, id } of defaults) {
		const model = getModel(provider, id);
		if (model) return model;
	}

	return undefined;
}

/**
 * Assemble the prompt sent to the duet model.
 * Includes minimal context: cwd + the user's message.
 */
export function assemblePrompt(cwd: string, userMessage: string): string {
	return `You are a second opinion assistant. The user is working in ${cwd} and asked:

${userMessage}

Provide a brief, thoughtful second perspective. Be concise.`;
}
