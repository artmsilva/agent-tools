import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDrydockCatalog } from "../guest/pi-provider.ts";
import { createAnthropicCredentialHeadersResolver } from "./anthropic-connector.ts";

test("Guest provider config contains only the host model catalog and a loopback sentinel", () => {
  let registered: { id: string; config: Record<string, unknown> } | undefined;
  registerDrydockCatalog({
    registerProvider(id: string, config: Record<string, unknown>) {
      registered = { id, config };
    },
  } as unknown as ExtensionAPI, {
    providers: [{
      id: "connected-provider",
      name: "Connected Provider",
      models: [{
        id: "connected-model",
        name: "Connected Model",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      }],
    }],
  });

  assert.equal(registered?.id, "connected-provider");
  assert.equal(registered?.config.baseUrl, "http://127.0.0.1:43127/model-stream");
  assert.equal(registered?.config.apiKey, "[TRIPWIRE:drydock-model-connector]");
  assert.doesNotMatch(JSON.stringify(registered), /secret|refresh|Bearer /);
});

test("maps a host API key to an upstream-only header", async () => {
  const resolve = createAnthropicCredentialHeadersResolver({
    readCredential: () => ({ type: "api_key", key: "host-api-secret" }),
  });

  assert.deepEqual(await resolve(), { "x-api-key": "host-api-secret" });
});

test("maps host OAuth to Claude Code bearer headers", async () => {
  const resolve = createAnthropicCredentialHeadersResolver({
    readCredential: () => ({
      type: "oauth",
      access: "host-oauth-secret",
      refresh: "host-refresh-secret",
      expires: 100_000,
    }),
    now: () => 0,
  });

  const headers = await resolve();
  assert.equal(headers.authorization, "Bearer host-oauth-secret");
  assert.match(headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
  assert.equal(JSON.stringify(headers).includes("host-refresh-secret"), false);
});

test("refreshes expiring OAuth in host memory without exposing the refresh token", async () => {
  let refreshes = 0;
  const resolve = createAnthropicCredentialHeadersResolver({
    readCredential: () => ({ type: "oauth", access: "expired", refresh: "refresh-secret", expires: 1 }),
    refreshOAuth: async (credential) => {
      refreshes += 1;
      assert.equal(credential.refresh, "refresh-secret");
      return { type: "oauth", access: "fresh-secret", refresh: "rotated-refresh-secret", expires: 100_000 };
    },
    now: () => 50_000,
  });

  assert.equal((await resolve()).authorization, "Bearer fresh-secret");
  assert.equal((await resolve()).authorization, "Bearer fresh-secret");
  assert.equal(refreshes, 1);
});

test("fails closed when host credentials are missing or malformed", async () => {
  await assert.rejects(createAnthropicCredentialHeadersResolver({ readCredential: () => undefined })(), /not configured/);
  await assert.rejects(
    createAnthropicCredentialHeadersResolver({ readCredential: () => ({ type: "api_key" }) })(),
    /invalid/,
  );
});
