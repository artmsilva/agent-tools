import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONNECTOR_BASE_URL = "http://127.0.0.1:43127";
const MODEL_ID = "claude-haiku-4-5";

export default function registerDrydockProvider(pi: ExtensionAPI) {
  pi.registerProvider("drydock-anthropic", {
    name: "Drydock Anthropic Connector",
    baseUrl: CONNECTOR_BASE_URL,
    // Non-secret sentinel: makes Pi format Anthropic OAuth requests while the
    // host broker discards Guest auth and injects the real credential.
    apiKey: "sk-ant-oat-drydock-non-secret",
    api: "anthropic-messages",
    models: [
      {
        id: MODEL_ID,
        name: "Claude Haiku 4.5 via Drydock",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
  });
}
