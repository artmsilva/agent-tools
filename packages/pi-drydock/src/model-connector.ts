import { randomUUID } from "node:crypto";
import {
  ModelRuntime,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConnectorRequest } from "./connector.ts";

const THINKING_LEVELS = new Set<NonNullable<ModelsSimpleStreamOptions["reasoning"]>>([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);
const CACHE_RETENTION = new Set<NonNullable<ModelsSimpleStreamOptions["cacheRetention"]>>(["none", "short", "long"]);

export interface ModelCatalog {
  providers: Array<{ id: string; name: string; models: ProviderModelConfig[] }>;
  defaultModel: { provider: string; model: string };
}

interface ModelRuntimeLike {
  getAvailable(): Promise<readonly Model<Api>[]>;
  getProvider(provider: string): { name: string } | undefined;
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
}

export interface HostModelConnector {
  catalog: ModelCatalog;
  handleRequest(request: ConnectorRequest): Promise<Response>;
}

export async function createHostModelConnector(runtime?: ModelRuntimeLike): Promise<HostModelConnector> {
  const host = runtime ?? await ModelRuntime.create({ allowModelNetwork: false });
  const models = [...await host.getAvailable()];
  if (models.length === 0) throw new Error("Host Pi has no configured model connections");
  const catalog = createCatalog(host, models);
  const available = new Map(models.map((model) => [modelKey(model.provider, model.id), model]));
  const sessionScope = randomUUID();
  return {
    catalog,
    handleRequest: (request) => handleModelRequest(request, host, available, sessionScope),
  };
}

function createCatalog(runtime: ModelRuntimeLike, models: Model<Api>[]): ModelCatalog {
  const grouped = new Map<string, Model<Api>[]>();
  for (const model of models) grouped.set(model.provider, [...grouped.get(model.provider) ?? [], model]);
  const providers = [...grouped].map(([id, providerModels]) => ({
    id: catalogIdentifier(id),
    name: runtime.getProvider(id)?.name ?? id,
    models: providerModels.map(publicModel),
  }));
  const preferred = models.find((model) => model.provider === "anthropic" && model.id === "claude-haiku-4-5") ?? models[0];
  return { providers, defaultModel: { provider: preferred.provider, model: preferred.id } };
}

function publicModel(model: Model<Api>): ProviderModelConfig {
  return {
    id: catalogIdentifier(model.id),
    name: model.name,
    api: "drydock-model-stream",
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

async function handleModelRequest(
  request: ConnectorRequest,
  runtime: ModelRuntimeLike,
  available: ReadonlyMap<string, Model<Api>>,
  sessionScope: string,
): Promise<Response> {
  const input = parseRequest(request.body);
  const model = available.get(modelKey(input.provider, input.model));
  if (!model) return new Response("Model is not available through the host", { status: 403 });
  const events = runtime.streamSimple(
    model,
    input.context,
    safeOptions(input.options, request.signal, model.maxTokens, sessionScope),
  );
  return new Response(eventBody(events, model), { headers: { "content-type": "application/x-ndjson" } });
}

function parseRequest(body: Buffer): {
  provider: string;
  model: string;
  context: Context;
  options: Record<string, unknown>;
} {
  const value = parseJsonRecord(body);
  return {
    provider: requiredString(value.provider),
    model: requiredString(value.model),
    context: requestContext(value.context),
    options: recordOrEmpty(value.options),
  };
}

function parseJsonRecord(body: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (isRecord(value)) return value;
  } catch {
    // The common error below deliberately hides parser details from the Guest.
  }
  throw new Error("Invalid host model connector request");
}

function requiredString(value: unknown): string {
  if (!boundedString(value)) throw new Error("Invalid host model connector request");
  return value;
}

function requestContext(value: unknown): Context {
  if (!isRecord(value)) throw new Error("Invalid host model connector context");
  if (!Array.isArray(value.messages)) throw new Error("Invalid host model connector context");
  return value as unknown as Context;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function safeOptions(
  values: Record<string, unknown>,
  signal: AbortSignal,
  modelMaxTokens: number,
  sessionScope: string,
): ModelsSimpleStreamOptions {
  return {
    signal,
    // Keep streamed provider events uncompressed across direct ModelRuntime callers.
    headers: { "accept-encoding": "identity" },
    temperature: finiteNumber(values.temperature),
    maxTokens: boundedMaxTokens(values.maxTokens, modelMaxTokens),
    reasoning: thinkingLevel(values.reasoning),
    cacheRetention: cacheRetention(values.cacheRetention),
    sessionId: scopedSessionId(sessionScope, values.sessionId),
  };
}

function eventBody(events: AsyncIterable<AssistantMessageEvent>, model: Model<Api>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(sanitizeEvent(event, model))}\n`));
        }
      } catch {
        controller.enqueue(encoder.encode(`${JSON.stringify(hostErrorEvent(model))}\n`));
      } finally {
        controller.close();
      }
    },
  });
}

function sanitizeEvent(event: AssistantMessageEvent, model: Model<Api>): AssistantMessageEvent {
  return event.type === "error" ? hostErrorEvent(model) : event;
}

function hostErrorEvent(model: Model<Api>): AssistantMessageEvent {
  const error: AssistantMessage = {
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
    errorMessage: "Host model connector failed",
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error };
}

function catalogIdentifier(value: string): string {
  if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error("Host Pi model catalog is invalid");
  return value;
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function scopedSessionId(scope: string, value: unknown): string | undefined {
  return boundedString(value) ? `${scope}:${value}` : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedMaxTokens(value: unknown, maximum: number): number | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  if ((value as number) <= 0) return undefined;
  return Math.min(value as number, maximum);
}

function thinkingLevel(value: unknown): ModelsSimpleStreamOptions["reasoning"] {
  return THINKING_LEVELS.has(value as NonNullable<ModelsSimpleStreamOptions["reasoning"]>)
    ? value as NonNullable<ModelsSimpleStreamOptions["reasoning"]>
    : undefined;
}

function cacheRetention(value: unknown): ModelsSimpleStreamOptions["cacheRetention"] {
  return CACHE_RETENTION.has(value as NonNullable<ModelsSimpleStreamOptions["cacheRetention"]>)
    ? value as NonNullable<ModelsSimpleStreamOptions["cacheRetention"]>
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
