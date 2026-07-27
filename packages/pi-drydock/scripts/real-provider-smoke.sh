#!/usr/bin/env bash
set -euo pipefail

# Opt-in end-to-end proof. Uses the host's existing Anthropic credential and
# spends real model tokens. The credential stays in host memory.

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"
STATE_ROOT="$(mktemp -d /tmp/pi-drydock-real-provider.XXXXXX)"
HOST_HASH_BEFORE="$(shasum -a 256 README.md)"
cleanup() { trash "$STATE_ROOT"; }
trap cleanup EXIT

node --experimental-strip-types - "$STATE_ROOT" <<'NODE'
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createAnthropicCredentialHeadersResolver } from "./src/anthropic-connector.ts";
import { attachConnectorBroker } from "./src/connector.ts";
import { containerResourceNames, DrydockControlPlane } from "./src/control-plane.ts";

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function install(container, source, destination) {
  const child = spawn("container", [
    "exec", "--interactive", "--uid", "0", "--gid", "0", container,
    "/bin/sh", "-c",
    `umask 022; mkdir -p /run/pi-drydock; chmod 0755 /run/pi-drydock; cat > ${destination}; chmod 0555 ${destination}`,
  ]);
  child.stdin.end(await readFile(source));
  await waitForExit(child);
}

const control = new DrydockControlPlane({
  stateRoot: process.argv[2],
  idleTimeoutMs: 0,
  operationTimeoutMs: 300_000,
});
const identity = await control.create("real-provider");
const { container } = containerResourceNames(identity.id);
let channel;
try {
  await control.open("real-provider");
  await install(container, "./guest/connector-shim.mjs", "/run/pi-drydock/connector-shim.mjs");
  await install(container, "./guest/pi-provider.ts", "/run/pi-drydock/pi-provider.ts");

  channel = spawn("container", [
    "exec", "--interactive", "--uid", "1000", "--gid", "1000", container,
    "/bin/sh", "-c", "DRYDOCK_CONNECTOR_PORT=43127 exec node /run/pi-drydock/connector-shim.mjs",
  ]);
  let channelError = "";
  channel.stderr.on("data", (chunk) => { channelError += chunk; });
  const broker = attachConnectorBroker({
    input: channel.stdout,
    output: channel.stdin,
    policy: {
      drydockId: identity.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      upstreamOrigin: "https://api.anthropic.com",
      allowedPath: "/v1/messages",
      maxRequestBytes: 20 * 1024 * 1024,
      maxResponseBytes: 20 * 1024 * 1024,
      maxConcurrent: 1,
      requestsPerMinute: 10,
      timeoutMs: 180_000,
      fixedHeaders: { "anthropic-version": "2023-06-01" },
    },
    resolveCredentialHeaders: createAnthropicCredentialHeadersResolver(),
  });

  await delay(300);
  const prompt = await control.exec(
    "real-provider",
    `pi -e /run/pi-drydock/pi-provider.ts --provider drydock-anthropic --model claude-haiku-4-5 --tools bash --no-session -p "Use the bash tool to run: printf DRYDOCK_TOOL_OK > /workspace/model-tool.txt. Then reply with exactly DRYDOCK_REAL_MODEL_OK"`,
  );
  if (prompt.exitCode !== 0 || !prompt.stdout.includes("DRYDOCK_REAL_MODEL_OK")) {
    throw new Error(JSON.stringify({ prompt, channelError }));
  }
  const boundary = await control.exec(
    "real-provider",
    `test "$(cat model-tool.txt)" = DRYDOCK_TOOL_OK && test "$(cat /sys/class/net/eth0/operstate)" = down && test ! -w /run/pi-drydock/connector-shim.mjs && node -e 'const fs=require("fs");const p="/home/node/.pi/agent/auth.json";if(!fs.existsSync(p)||Object.keys(JSON.parse(fs.readFileSync(p))).length!==0)process.exit(1)'`,
  );
  if (boundary.exitCode !== 0) throw new Error(JSON.stringify(boundary));

  channel.stdin.end();
  await broker;
  channel = undefined;
  const expired = await control.exec(
    "real-provider",
    `node -e 'fetch("http://127.0.0.1:43127/.well-known/pi-drydock-connector").then(()=>process.exit(1)).catch(()=>process.exit(0))'`,
  );
  if (expired.exitCode !== 0) throw new Error("Connector capability survived channel closure");
  console.log("PASS: real_model=yes pi_inside=yes guest_tool=yes connector=yes host_auth_only=yes eth0=down guest_credentials=zero capability_expired=yes");
  await control.hibernate("real-provider");
} finally {
  channel?.kill("SIGKILL");
  await control.destroy("real-provider");
}
NODE

[[ "$HOST_HASH_BEFORE" == "$(shasum -a 256 README.md)" ]]
printf 'PASS: host_unchanged=yes\n'
