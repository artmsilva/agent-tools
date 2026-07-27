#!/usr/bin/env bash
set -euo pipefail

# Opt-in real-hardware proof of the credentialless transport. The upstream is
# an in-process fake: this proves guest-loopback -> container-exec stdio ->
# host broker streaming while eth0 stays down. It does not spend model tokens.

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"
STATE_ROOT="$(mktemp -d /tmp/pi-drydock-connector-smoke.XXXXXX)"
HOST_HASH_BEFORE="$(shasum -a 256 README.md)"
cleanup() { trash "$STATE_ROOT"; }
trap cleanup EXIT

node --experimental-strip-types - "$STATE_ROOT" <<'NODE'
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { attachConnectorBroker } from "./src/connector.ts";
import { containerResourceNames, DrydockControlPlane } from "./src/control-plane.ts";

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

const control = new DrydockControlPlane({ stateRoot: process.argv[2], idleTimeoutMs: 0 });
const identity = await control.create("connector-smoke");
const { container } = containerResourceNames(identity.id);
let channel;
try {
  await control.open("connector-smoke");
  const install = spawn("container", [
    "exec", "--interactive", "--uid", "0", "--gid", "0", container,
    "/bin/sh", "-c",
    "umask 022; mkdir -p /run/pi-drydock; chmod 0755 /run/pi-drydock; cat > /run/pi-drydock/connector-shim.mjs; chmod 0555 /run/pi-drydock/connector-shim.mjs",
  ]);
  install.stdin.end(await readFile("./guest/connector-shim.mjs"));
  await waitForExit(install);

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
      model: "claude-test",
      upstreamOrigin: "https://api.example.test",
      allowedPath: "/v1/messages",
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      requestsPerMinute: 5,
      timeoutMs: 1000,
    },
    resolveCredentialHeaders: async () => ({ "x-api-key": "host-only-sentinel" }),
    fetch: async (_input, init) => {
      if (new Headers(init?.headers).get("x-api-key") !== "host-only-sentinel") {
        throw new Error("host credential injection missing");
      }
      return new Response("data: {\"type\":\"message_stop\"}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  let result;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await control.exec(
      "connector-smoke",
      `node -e 'fetch("http://127.0.0.1:43127/v1/messages",{method:"POST",headers:{authorization:"Bearer guest"},body:JSON.stringify({model:"claude-test",messages:[]})}).then(async r=>{console.log(r.status);console.log(await r.text())}).catch(()=>process.exit(75))'`,
    );
    if (result.exitCode === 0) break;
    await delay(100);
  }
  if (result.exitCode !== 0 || !result.stdout.includes("message_stop")) {
    throw new Error(JSON.stringify({ result, channelError }));
  }
  const boundary = await control.exec(
    "connector-smoke",
    'test ! -e /home/node/.pi/agent/auth.json && test "$(cat /sys/class/net/eth0/operstate)" = down && test ! -w /run/pi-drydock/connector-shim.mjs',
  );
  if (boundary.exitCode !== 0) throw new Error(JSON.stringify(boundary));
  console.log("PASS: loopback_connector=yes exec_stdio=yes streaming=yes host_auth_only=yes eth0=down guest_auth=absent shim_read_only=yes");

  channel.stdin.end();
  await broker;
  channel = undefined;
  await control.hibernate("connector-smoke");
} finally {
  channel?.kill("SIGKILL");
  await control.destroy("connector-smoke");
}
NODE

[[ "$HOST_HASH_BEFORE" == "$(shasum -a 256 README.md)" ]]
printf 'PASS: host_unchanged=yes\n'
