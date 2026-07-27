import { readFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const CONNECTOR_URL = "http://127.0.0.1:43127/model-stream";
const CATALOG_PATH = "/run/pi-drydock/model-catalog.json";
// Pi needs configured auth to expose a provider; this value carries no authority.
// The host ModelRuntime resolves and uses the real provider credential.
const SENTINEL = "[TRIPWIRE:drydock-model-connector]";

type Catalog = {
  providers: Array<{ id: string; name: string; models: ProviderModelConfig[] }>;
};

export default function registerDrydockProviders(pi: ExtensionAPI) {
  registerDrydockCatalog(pi, JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog);
}

export function registerDrydockCatalog(pi: ExtensionAPI, catalog: Catalog) {
  for (const provider of catalog.providers) {
    pi.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: CONNECTOR_URL,
      apiKey: SENTINEL,
      api: "drydock-model-stream" as Api,
      models: provider.models,
      streamSimple: streamThroughHost,
    });
  }
}

function streamThroughHost(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void relay(stream, model, context, options);
  return stream;
}

async function relay(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  try {
    const response = await fetch(CONNECTOR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: model.provider, model: model.id, context, options: publicOptions(options) }),
      signal: requestSignal(options),
    });
    for await (const event of readEvents(requireResponseBody(response))) stream.push(event);
  } catch (error) {
    stream.push(errorEvent(model, error));
  }
}

function requestSignal(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  return options ? options.signal : undefined;
}

function requireResponseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.ok) throw new Error(`Host model connector failed (${response.status})`);
  if (!response.body) throw new Error("Host model connector returned no stream");
  return response.body;
}

function publicOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
  if (!options) return {};
  const { apiKey: _apiKey, env: _env, headers: _headers, signal: _signal, ...publicValues } = options;
  return publicValues;
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantMessageEvent> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    const complete = takeCompleteLines(pending);
    pending = complete.remainder;
    for (const event of complete.events) yield event;
  }
  pending += decoder.decode();
  if (pending) yield parseEvent(pending);
}

function takeCompleteLines(value: string): { events: AssistantMessageEvent[]; remainder: string } {
  const lines = value.split("\n");
  const remainder = lines.pop() ?? "";
  return { events: lines.filter(Boolean).map(parseEvent), remainder };
}

function parseEvent(value: string): AssistantMessageEvent {
  return JSON.parse(value) as AssistantMessageEvent;
}

function errorEvent(model: Model<Api>, error: unknown): AssistantMessageEvent {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error: message };
}
