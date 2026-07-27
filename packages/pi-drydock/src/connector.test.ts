import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { attachConnectorBroker, type ConnectorPolicy, type ConnectorRequest } from "./connector.ts";

const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
  children.clear();
});

function policy(overrides: Partial<ConnectorPolicy> = {}): ConnectorPolicy {
  return {
    drydockId: "11111111-1111-4111-8111-111111111111",
    provider: "anthropic",
    model: "claude-test",
    upstreamOrigin: "https://api.example.test",
    allowedPath: "/v1/messages",
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    maxConcurrent: 1,
    requestsPerMinute: 10,
    timeoutMs: 1000,
    fixedHeaders: { "anthropic-version": "2023-06-01" },
    ...overrides,
  };
}

async function startConnector(
  connectorPolicy: ConnectorPolicy,
  fetchImpl: typeof fetch,
  credentialHeaders: Readonly<Record<string, string>> = { "x-api-key": "host-secret" },
  handleRequest?: (request: ConnectorRequest) => Promise<Response>,
) {
  const port = await availablePort();
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "guest", "connector-shim.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { DRYDOCK_CONNECTOR_PORT: String(port) },
  });
  children.add(child);
  const broker = attachConnectorBroker({
    input: child.stdout,
    output: child.stdin,
    policy: connectorPolicy,
    resolveCredentialHeaders: async () => credentialHeaders,
    fetch: fetchImpl,
    handleRequest,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/.well-known/pi-drydock-connector`);
  return { baseUrl, child, broker };
}

test("streams an approved request while replacing guest authorization with host credentials", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "request-1", "set-cookie": "secret" },
    });
  };
  const { baseUrl } = await startConnector(policy(), fetchImpl);

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer guest-token", connection: "keep-alive", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-test", messages: [] }),
  });

  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  assert.equal(response.headers.get("x-request-id"), "request-1");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(captured?.url, "https://api.example.test/v1/messages");
  const headers = new Headers(captured?.init?.headers);
  assert.equal(headers.get("x-api-key"), "host-secret");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("accept-encoding"), "identity");
  assert.equal(captured?.init?.redirect, "error");
});

test("routes catalog-allowed model requests to a host semantic handler", async () => {
  let requestBody = "";
  const { baseUrl } = await startConnector(
    policy({
      provider: "host-pi",
      model: "gpt-test",
      allowedModels: [{ provider: "openai-codex", model: "gpt-test" }],
      allowedPath: "/model-stream",
    }),
    async () => { throw new Error("HTTP forwarding must not run"); },
    {},
    async ({ body }) => {
      requestBody = body.toString("utf8");
      return new Response('{"type":"done"}\n', { headers: { "content-type": "application/x-ndjson" } });
    },
  );

  const response = await fetch(`${baseUrl}/model-stream`, {
    method: "POST",
    body: JSON.stringify({ provider: "openai-codex", model: "gpt-test" }),
  });
  assert.equal(await response.text(), '{"type":"done"}\n');
  assert.match(requestBody, /openai-codex/);
  assert.equal((await fetch(`${baseUrl}/model-stream`, {
    method: "POST",
    body: JSON.stringify({ provider: "openai-codex", model: "not-allowed" }),
  })).status, 403);
});

test("multiplexes an explicitly configured GitHub semantic route", async () => {
  const seen: string[] = [];
  const { baseUrl } = await startConnector(
    policy({
      allowedPath: "/model-stream",
      github: {
        repository: { host: "github.com", owner: "artmsilva", name: "agent-tools" },
        permissions: ["repo:read"],
      },
    }),
    async () => { throw new Error("HTTP forwarding must not run"); },
    {},
    async ({ path }) => {
      seen.push(path);
      return Response.json({ ok: true });
    },
  );

  assert.equal((await fetch(`${baseUrl}/github`, {
    method: "POST",
    body: JSON.stringify({ operation: "repo.view" }),
  })).status, 200);
  assert.deepEqual(seen, ["/github"]);
  assert.equal((await fetch(`${baseUrl}/not-allowed`, {
    method: "POST",
    body: JSON.stringify({ operation: "repo.view" }),
  })).status, 404);
});

test("exposes effective policy read-only and denies method, path, and model changes", async () => {
  let calls = 0;
  const connectorPolicy = policy();
  const { baseUrl } = await startConnector(connectorPolicy, async () => {
    calls += 1;
    return new Response("unexpected");
  });

  const effective = await (await fetch(`${baseUrl}/.well-known/pi-drydock-connector`)).json();
  assert.deepEqual(effective, connectorPolicy);
  assert.equal((await fetch(`${baseUrl}/v1/messages`, { method: "GET" })).status, 405);
  assert.equal(
    (
      await fetch(`${baseUrl}/v1/other`, {
        method: "POST",
        body: JSON.stringify({ model: "claude-test" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "other" }),
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
});

test("enforces rate, timeout, and response limits", async () => {
  let calls = 0;
  const rateLimited = await startConnector(policy({ requestsPerMinute: 1 }), async () => {
    calls += 1;
    return new Response("ok");
  });
  const request = { method: "POST", body: JSON.stringify({ model: "claude-test" }) };
  assert.equal((await fetch(`${rateLimited.baseUrl}/v1/messages`, request)).status, 200);
  assert.equal((await fetch(`${rateLimited.baseUrl}/v1/messages`, request)).status, 429);
  assert.equal(calls, 1);
  rateLimited.child.kill("SIGKILL");
  await rateLimited.broker;
  children.delete(rateLimited.child);

  const denied = await startConnector(policy({ requestsPerMinute: 1 }), async () => new Response("unexpected"));
  const invalid = await fetch(`${denied.baseUrl}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "other" }),
  });
  assert.equal(invalid.status, 403);
  assert.equal((await fetch(`${denied.baseUrl}/v1/messages`, request)).status, 429);
  denied.child.kill("SIGKILL");
  await denied.broker;
  children.delete(denied.child);

  const timedOut = await startConnector(policy({ timeoutMs: 20 }), async (_input, init) => {
    await new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    return new Response("unreachable");
  });
  assert.equal((await fetch(`${timedOut.baseUrl}/v1/messages`, request)).status, 502);
  timedOut.child.kill("SIGKILL");
  await timedOut.broker;
  children.delete(timedOut.child);

  const oversized = await startConnector(policy({ maxResponseBytes: 4 }), async () => new Response("too large"));
  await assert.rejects(fetch(`${oversized.baseUrl}/v1/messages`, request).then((response) => response.text()));
});

test("rejects credentials in public policy and redacts host credential failures", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  await assert.rejects(
    attachConnectorBroker({
      input,
      output,
      policy: policy({ fixedHeaders: { "x-api-key": "must-not-cross" } }),
      resolveCredentialHeaders: async () => ({}),
    }),
    /credentials require a resolver/,
  );

  const { baseUrl } = await startConnector(
    policy(),
    async () => new Response("unreachable"),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("host-secret-must-not-cross");
        },
      },
    ),
  );
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-test" }),
  });
  const message = await response.text();
  assert.equal(response.status, 502);
  assert.equal(message, "Connector upstream failed");
  assert.doesNotMatch(message, /host-secret/);
});

test("closing the host channel expires the guest Connector", async () => {
  const { baseUrl, child, broker } = await startConnector(policy(), async () => new Response("ok"));

  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end();
  await Promise.all([broker, closed]);
  children.delete(child);

  await assert.rejects(fetch(`${baseUrl}/.well-known/pi-drydock-connector`));
});

test("rejects an oversized raw protocol frame before parsing or upstream access", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let calls = 0;
  const broker = attachConnectorBroker({
    input,
    output,
    policy: policy({ maxRequestBytes: 8 }),
    resolveCredentialHeaders: async () => ({ "x-api-key": "host-secret" }),
    fetch: async () => {
      calls += 1;
      return new Response("unexpected");
    },
  });

  input.end("x".repeat(70_000));

  await assert.rejects(broker, /frame limit exceeded/);
  assert.equal(calls, 0);
});

test("enforces request size and concurrency before upstream access", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { baseUrl } = await startConnector(policy({ maxRequestBytes: 80 }), async () => {
    calls += 1;
    await gate;
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  });

  const first = fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-test" }),
  });
  await waitFor(() => calls === 1);
  const concurrent = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-test" }),
  });
  assert.equal(concurrent.status, 429);
  const oversized = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "x".repeat(81) });
  assert.equal(oversized.status, 413);
  release();
  assert.equal(await (await first).text(), "ok");
  assert.equal(calls, 1);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve Connector test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForHttp(url: string): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(url)).status === 200;
    } catch {
      return false;
    }
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(10);
  }
}
