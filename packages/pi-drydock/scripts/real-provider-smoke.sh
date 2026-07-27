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
import { setTimeout as delay } from "node:timers/promises";
import { createAnthropicCredentialHeadersResolver } from "./src/anthropic-connector.ts";
import { DrydockControlPlane } from "./src/control-plane.ts";

const control = new DrydockControlPlane({
  stateRoot: process.argv[2],
  idleTimeoutMs: 1_000,
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

  const shellSession = await control.startSession("real-provider", "bash", [
    "-lc",
    "echo SESSION_START; sleep 2; echo SESSION_ATTACHED; sleep 2; echo SESSION_CONTINUED; exec bash",
  ]);
  const firstAttachment = await control.attachSession("real-provider", shellSession.id);
  await waitForOutput(firstAttachment, "SESSION_ATTACHED");
  await control.resizeSession("real-provider", shellSession.id, 120, 40);
  firstAttachment.detach();
  await firstAttachment.closed;
  await waitForCapture(shellSession.id, "SESSION_CONTINUED");
  const secondAttachment = await control.attachSession("real-provider", shellSession.id);
  secondAttachment.input.write("echo SESSION_REATTACHED\n");
  await waitForOutput(secondAttachment, "SESSION_REATTACHED");
  secondAttachment.detach();
  await secondAttachment.closed;
  await control.stopSession("real-provider", shellSession.id);

  const promptSession = await control.startSession("real-provider", "pi", [
    "-e",
    "/run/pi-drydock/pi-provider.ts",
    "--provider",
    "drydock-anthropic",
    "--model",
    "claude-haiku-4-5",
    "--tools",
    "bash",
    "--no-session",
    "-p",
    "Use the bash tool to run: printf DRYDOCK_TOOL_OK > /workspace/model-tool.txt. Then reply with exactly DRYDOCK_REAL_MODEL_OK",
  ]);
  await waitForCapture(promptSession.id, "DRYDOCK_REAL_MODEL_OK", 180_000);

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

  // Closing the final non-session lease lets the exited Pi session probe
  // release exactly once and automatic idle hibernation proceed.
  await connector.close();
  await waitForColdOpen();
  if ((await control.listSessions("real-provider")).length !== 0) throw new Error("Guest process session survived hibernation");
  const cold = await control.exec(
    "real-provider",
    "test ! -e /run/pi-drydock/connector-shim.mjs && test ! -e /home/node/.pi/agent/auth.json && test \"$(cat model-tool.txt)\" = DRYDOCK_TOOL_OK",
  );
  if (cold.exitCode !== 0) throw new Error(JSON.stringify(cold));
  console.log("PASS: real_model=yes pi_inside=yes guest_tool=yes session_attach=yes session_detach=yes session_buffer=yes session_resize=yes session_exit_release=yes connector=yes connector_closed=yes host_auth_only=yes eth0=down guest_credentials=zero dns_blocked=yes direct_ip_blocked=yes host_gateway_blocked=yes alternate_port_blocked=yes auto_hibernate=yes processes_disposable=yes cold_restore=yes");
  await control.hibernate("real-provider");
} finally {
  await control.destroy("real-provider");
}

async function waitForColdOpen(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await control.open("real-provider");
      return;
    } catch (error) {
      if (!/already active|transition in progress/.test(String(error))) throw error;
      if (Date.now() >= deadline) throw new Error("Exited session did not release its activity lease");
      await delay(100);
    }
  }
}

async function waitForCapture(id, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const output = await control.captureSession("real-provider", id, 1000);
    if (output.includes(expected)) return;
    if (Date.now() >= deadline) throw new Error(`Session output missing ${expected}: ${output}`);
    await delay(100);
  }
}

function waitForOutput(attachment, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      attachment.output.off("data", onData);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) finish();
    };
    const timeout = setTimeout(
      () => finish(new Error(`Attachment output missing ${expected}: ${output}`)),
      timeoutMs,
    );
    attachment.output.on("data", onData);
    attachment.output.once("error", finish);
    attachment.closed.then(
      () => finish(new Error(`Attachment closed before ${expected}: ${output}`)),
      finish,
    );
  });
}
NODE

[[ "$HOST_HASH_BEFORE" == "$(shasum -a 256 README.md)" ]]
printf 'PASS: host_unchanged=yes\n'
