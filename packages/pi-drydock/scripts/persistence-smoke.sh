#!/usr/bin/env bash
set -euo pipefail

# Opt-in real-hardware smoke test for one manual cold cycle against Apple
# `container` and pi-drydock-pi:latest. Requires Apple silicon, macOS 26, and
# `container system start`. Not run by `npm test`.

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"

STATE_ROOT="$(mktemp -d /tmp/pi-drydock-persistence-smoke.XXXXXX)"
NAME="persistence-smoke"
HOST_FILE="${DRYDOCK_SMOKE_HOST_FILE:-README.md}"
HOST_HASH_BEFORE="$(shasum -a 256 "$HOST_FILE")"
cleanup() { trash "$STATE_ROOT"; }
trap cleanup EXIT

node --experimental-strip-types - "$STATE_ROOT" "$NAME" <<'NODE'
import { DrydockControlPlane } from "./src/control-plane.ts";

const [stateRoot, name] = process.argv.slice(2);
const control = new DrydockControlPlane({ stateRoot });
let created = false;
try {
  await control.create(name);
  created = true;
  console.log(`created ${name}`);

  await control.open(name);
  console.log("opened (cold start)");

  const write = await control.exec(name, "echo smoke > keep.txt && cat keep.txt");
  if (write.exitCode !== 0 || write.stdout !== "smoke\n") {
    throw new Error(`unexpected exec result: ${JSON.stringify(write)}`);
  }

  await control.hibernate(name);
  console.log("hibernated (snapshot committed, compute deleted)");

  await control.open(name);
  const read = await control.exec(name, "cat keep.txt");
  if (read.exitCode !== 0 || read.stdout !== "smoke\n") {
    throw new Error(`restored content mismatch: ${JSON.stringify(read)}`);
  }
  console.log("PASS: keep.txt survived open/exec/hibernate/open");
} finally {
  if (created) await control.destroy(name);
}
NODE

HOST_HASH_AFTER="$(shasum -a 256 "$HOST_FILE")"
[[ "$HOST_HASH_BEFORE" == "$HOST_HASH_AFTER" ]]
printf 'PASS: host_unchanged=yes\n'
