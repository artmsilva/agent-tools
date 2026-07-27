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
import { createAnthropicCredentialHeadersResolver } from "./src/anthropic-connector.ts";
import { DrydockControlPlane } from "./src/control-plane.ts";

const control = new DrydockControlPlane({
  stateRoot: process.argv[2],
  idleTimeoutMs: 0,
  operationTimeoutMs: 300_000,
});
await control.create("real-provider");
try {
  await control.open("real-provider");
  const connector = await control.openConnector("real-provider", {
    policy: {
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
    capabilityTtlMs: 5 * 60_000,
  });

  const prompt = await control.exec(
    "real-provider",
    `pi -e /run/pi-drydock/pi-provider.ts --provider drydock-anthropic --model claude-haiku-4-5 --tools bash --no-session -p "Use the bash tool to run: printf DRYDOCK_TOOL_OK > /workspace/model-tool.txt. Then reply with exactly DRYDOCK_REAL_MODEL_OK"`,
  );
  if (prompt.exitCode !== 0 || !prompt.stdout.includes("DRYDOCK_REAL_MODEL_OK")) {
    throw new Error(JSON.stringify(prompt));
  }
  const boundary = await control.exec(
    "real-provider",
    `test "$(cat model-tool.txt)" = DRYDOCK_TOOL_OK && test "$(cat /sys/class/net/eth0/operstate)" = down && test ! -w /run/pi-drydock/connector-shim.mjs && node -e 'const fs=require("fs");const p="/home/node/.pi/agent/auth.json";if(!fs.existsSync(p)||Object.keys(JSON.parse(fs.readFileSync(p))).length!==0)process.exit(1)'`,
  );
  if (boundary.exitCode !== 0) throw new Error(JSON.stringify(boundary));
  const networkProbe = await control.exec(
    "real-provider",
    `GATEWAY="$(ip route show default | while read -r _ _ gateway _; do echo "$gateway"; break; done)"; test -n "$GATEWAY"; export GATEWAY; node -e 'const urls=["http://127.0.0.1:43128","http://1.1.1.1","https://api.anthropic.com","http://"+process.env.GATEWAY+":43127"];Promise.all(urls.map(async u=>{try{await fetch(u,{signal:AbortSignal.timeout(1000)});return false}catch{return true}})).then(r=>process.exit(r.every(Boolean)?0:1))'`,
  );
  if (networkProbe.exitCode !== 0) throw new Error(`Network escape probe failed: ${JSON.stringify(networkProbe)}`);

  // Managed hibernation closes the Connector lease/capability first.
  await control.hibernate("real-provider");
  await connector.closed;
  await control.open("real-provider");
  const cold = await control.exec(
    "real-provider",
    "test ! -e /run/pi-drydock/connector-shim.mjs && test ! -e /home/node/.pi/agent/auth.json && test \"$(cat model-tool.txt)\" = DRYDOCK_TOOL_OK",
  );
  if (cold.exitCode !== 0) throw new Error(JSON.stringify(cold));
  console.log("PASS: real_model=yes pi_inside=yes guest_tool=yes connector=yes host_auth_only=yes eth0=down guest_credentials=zero dns_blocked=yes direct_ip_blocked=yes host_gateway_blocked=yes alternate_port_blocked=yes hibernate_expired=yes cold_restore=yes");
  await control.hibernate("real-provider");
} finally {
  await control.destroy("real-provider");
}
NODE

[[ "$HOST_HASH_BEFORE" == "$(shasum -a 256 README.md)" ]]
printf 'PASS: host_unchanged=yes\n'
