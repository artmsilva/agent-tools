import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { attachConnectorBroker, type ConnectorPolicy } from "./connector.ts";
import { manageConnectorSession } from "./connector-session.ts";

const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

function policy(): ConnectorPolicy {
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
  };
}

async function channel() {
  const port = await availablePort();
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "guest", "connector-shim.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { DRYDOCK_CONNECTOR_PORT: String(port) },
  });
  children.add(child);
  const broker = attachConnectorBroker({
    input: child.stdout,
    output: child.stdin,
    policy: policy(),
    resolveCredentialHeaders: async () => ({ "x-api-key": "host-secret" }),
    fetch: async () => new Response("ok"),
  });
  await waitForHttp(`http://127.0.0.1:${port}/.well-known/pi-drydock-connector`);
  return { child, broker, port };
}

test("capability TTL closes the channel and releases its activity lease once", async () => {
  const { child, broker, port } = await channel();
  let releases = 0;
  const session = manageConnectorSession({
    channel: child,
    broker,
    releaseLease: () => {
      releases += 1;
    },
    capabilityTtlMs: 30,
  });

  await session.closed;

  assert.equal(releases, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/.well-known/pi-drydock-connector`));
  await session.close();
  assert.equal(releases, 1);
  children.delete(child);
});

test("unexpected channel death expires capability, releases lease, and reports failure", async () => {
  const { child, broker } = await channel();
  let releases = 0;
  const errors: Error[] = [];
  const session = manageConnectorSession({
    channel: child,
    broker,
    releaseLease: () => {
      releases += 1;
    },
    capabilityTtlMs: 60_000,
    onBackgroundError: (error) => errors.push(error),
  });

  child.kill("SIGKILL");
  await assert.rejects(session.closed, /channel failed/);

  assert.equal(releases, 1);
  assert.equal(errors.length, 1);
  children.delete(child);
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
  const deadline = Date.now() + 2000;
  while (!(await connectorAvailable(url))) {
    if (Date.now() >= deadline) throw new Error("Connector did not start");
    await delay(10);
  }
}

async function connectorAvailable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).status === 200;
  } catch {
    return false;
  }
}
