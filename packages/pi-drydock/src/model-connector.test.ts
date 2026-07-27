import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createHostModelConnector } from "./model-connector.ts";

const model: Model<Api> = {
  id: "connected-model",
  name: "Connected Model",
  api: "openai-responses",
  provider: "connected-provider",
  baseUrl: "https://secret-upstream.example/v1",
  headers: { authorization: "secret" },
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};

test("exposes every host-available model without endpoints or credentials", async () => {
  let received: ModelsSimpleStreamOptions | undefined;
  const connector = await createHostModelConnector({
    getAvailable: async () => [model],
    getProvider: () => ({ name: "Connected Provider" }),
    streamSimple: (_model, _context, options) => {
      received = options;
      return successfulEvents();
    },
  });

  const serializedCatalog = JSON.stringify(connector.catalog);
  assert.match(serializedCatalog, /connected-provider/);
  assert.doesNotMatch(serializedCatalog, /secret|upstream|authorization/);

  const response = await connector.handleRequest({
    signal: new AbortController().signal,
    body: Buffer.from(JSON.stringify({
      provider: model.provider,
      model: model.id,
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      options: {
        reasoning: "high",
        maxTokens: 500,
        sessionId: "guest-session",
        apiKey: "guest-key",
        headers: { authorization: "guest-header" },
        env: { AWS_PROFILE: "guest-profile" },
      },
    })),
  });

  assert.equal(response.status, 200);
  assert.match(await response.text(), /"type":"done"/);
  assert.ok(received);
  assert.equal(received.reasoning, "high");
  assert.equal(received.maxTokens, 500);
  assert.match(received.sessionId ?? "", /^[0-9a-f-]{36}:guest-session$/);
  assert.equal(received.apiKey, undefined);
  assert.deepEqual(received.headers, { "accept-encoding": "identity" });
  assert.equal(received.env, undefined);
});

test("redacts host provider errors before returning them to the Guest", async () => {
  const connector = await createHostModelConnector({
    getAvailable: async () => [model],
    getProvider: () => ({ name: "Connected Provider" }),
    streamSimple: () => failedEvents(),
  });
  const response = await connector.handleRequest({
    signal: new AbortController().signal,
    body: Buffer.from(JSON.stringify({
      provider: model.provider,
      model: model.id,
      context: { messages: [] },
    })),
  });
  const body = await response.text();
  assert.doesNotMatch(body, /host-secret|\/Users\/host/);
  assert.match(body, /Host model connector failed/);
});

test("denies models absent from the host availability snapshot", async () => {
  const connector = await createHostModelConnector({
    getAvailable: async () => [model],
    getProvider: () => ({ name: "Connected Provider" }),
    streamSimple: () => successfulEvents(),
  });
  const response = await connector.handleRequest({
    signal: new AbortController().signal,
    body: Buffer.from(JSON.stringify({
      provider: model.provider,
      model: "not-connected",
      context: { messages: [] },
    })),
  });
  assert.equal(response.status, 403);
});

async function* failedEvents(): AsyncGenerator<AssistantMessageEvent> {
  yield {
    type: "error",
    reason: "error",
    error: { ...assistantMessage(), stopReason: "error", errorMessage: "host-secret at /Users/host/config" },
  };
}

async function* successfulEvents(): AsyncGenerator<AssistantMessageEvent> {
  yield { type: "done", reason: "stop", message: assistantMessage() };
}

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}
