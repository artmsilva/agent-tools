#!/usr/bin/env bash
set -euo pipefail

# Opt-in end-to-end proof. Uses the host's existing Anthropic credential and
# spends real model tokens. The credential stays in host memory.
# Run from a real terminal because the supported foreground path requires a TTY.

[[ -t 0 && -t 1 ]] || { printf 'real-provider-smoke requires an interactive terminal\n' >&2; exit 2; }

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"
STATE_ROOT="$(mktemp -d /tmp/pi-drydock-real-provider.XXXXXX)"
HOST_HASH_BEFORE="$(shasum -a 256 README.md)"
cleanup() { trash "$STATE_ROOT"; }
trap cleanup EXIT

NODE_SCRIPT="$STATE_ROOT/smoke.mjs"
cat > "$NODE_SCRIPT" <<'NODE'
import { pathToFileURL } from "node:url";

const packageUrl = pathToFileURL(`${process.argv[3]}/`);
const { createAnthropicCredentialHeadersResolver } = await import(new URL("src/anthropic-connector.ts", packageUrl).href);
const { DrydockControlPlane } = await import(new URL("src/control-plane.ts", packageUrl).href);

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

  const promptExit = await control.runForeground("real-provider", "pi", [
    "--session-id",
    "00000000-0000-4000-8000-000000000001",
    "--tools",
    "bash",
    "-p",
    "Use the bash tool to run: printf DRYDOCK_TOOL_OK > /workspace/model-tool.txt. Then reply with exactly DRYDOCK_REAL_MODEL_OK",
  ], { tty: true });
  if (promptExit !== 0) throw new Error(`Foreground Pi failed: ${promptExit}`);

  const boundary = await control.exec(
    "real-provider",
    `test "$(cat model-tool.txt)" = DRYDOCK_TOOL_OK && test -n "$(find /home/node/.pi/agent/sessions -type f -print -quit)" && test "$(cat /sys/class/net/eth0/operstate)" = down && test ! -w /run/pi-drydock/connector-shim.mjs && node -e 'const fs=require("fs");const p="/home/node/.pi/agent/auth.json";if(!fs.existsSync(p)||Object.keys(JSON.parse(fs.readFileSync(p))).length!==0)process.exit(1)'`,
  );
  if (boundary.exitCode !== 0) throw new Error(JSON.stringify(boundary));
  const networkProbe = await control.exec(
    "real-provider",
    `GATEWAY="$(ip route show default | while read -r _ _ gateway _; do echo "$gateway"; break; done)"; test -n "$GATEWAY"; export GATEWAY; node -e 'const urls=["http://127.0.0.1:43128","http://1.1.1.1","https://api.anthropic.com","http://"+process.env.GATEWAY+":43127"];Promise.all(urls.map(async u=>{try{await fetch(u,{signal:AbortSignal.timeout(1000)});return false}catch{return true}})).then(r=>process.exit(r.every(Boolean)?0:1))'`,
  );
  if (networkProbe.exitCode !== 0) throw new Error(`Network escape probe failed: ${JSON.stringify(networkProbe)}`);

  await connector.close();
  await control.hibernate("real-provider");
  await control.open("real-provider");
  const cold = await control.exec(
    "real-provider",
    "test ! -e /run/pi-drydock/connector-shim.mjs && test ! -e /home/node/.pi/agent/auth.json && test \"$(cat model-tool.txt)\" = DRYDOCK_TOOL_OK && test -n \"$(find /home/node/.pi/agent/sessions -type f -print -quit)\"",
  );
  if (cold.exitCode !== 0) throw new Error(JSON.stringify(cold));
  console.log("PASS: real_model=yes pi_inside=yes direct_foreground=yes guest_tool=yes conversation_persisted=yes connector=yes connector_closed=yes host_auth_only=yes eth0=down guest_credentials=zero dns_blocked=yes direct_ip_blocked=yes host_gateway_blocked=yes alternate_port_blocked=yes processes_disposable=yes cold_restore=yes");
  await control.hibernate("real-provider");
} finally {
  await control.destroy("real-provider");
}
NODE
node --experimental-strip-types "$NODE_SCRIPT" "$STATE_ROOT" "$PACKAGE_DIR"

[[ "$HOST_HASH_BEFORE" == "$(shasum -a 256 README.md)" ]]
printf 'PASS: host_unchanged=yes\n'
