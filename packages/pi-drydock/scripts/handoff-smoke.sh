#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"
STATE_ROOT="$(mktemp -d /tmp/pi-drydock-handoff-state.XXXXXX)"
SOURCE_ROOT="$(mktemp -d /tmp/pi-drydock-handoff-source.XXXXXX)"
cleanup() { trash "$STATE_ROOT" "$SOURCE_ROOT"; }
trap cleanup EXIT

cd "$SOURCE_ROOT"
git init -q
git config user.name "Drydock Smoke"
git config user.email "drydock@example.invalid"
printf 'host baseline\n' > tracked.txt
printf '\000\001\002\003' > binary.bin
printf 'ignored\n' > ignored.txt
printf 'ignored.txt\n' > .gitignore
git add tracked.txt binary.bin .gitignore
git commit -qm baseline
HOST_HASH_BEFORE="$(git hash-object tracked.txt binary.bin)"
cd "$PACKAGE_DIR"

node --experimental-strip-types - "$STATE_ROOT" "$SOURCE_ROOT" <<'NODE'
import { realpath } from "node:fs/promises";
import { DrydockControlPlane } from "./src/control-plane.ts";

const stateRoot = process.argv[2];
const sourceRoot = await realpath(process.argv[3]);
const control = new DrydockControlPlane({ stateRoot, idleTimeoutMs: 0, operationTimeoutMs: 300_000 });
await control.create("handoff-smoke");
try {
  await control.open("handoff-smoke");
  const binding = await control.importWorkspace("handoff-smoke", sourceRoot);
  if (binding.trackedFiles !== 3) throw new Error(`Unexpected tracked file count: ${binding.trackedFiles}`);
  const boundary = await control.exec(
    "handoff-smoke",
    `test ! -w /baseline && test ! -e ignored.txt && printf 'guest edit\n' > tracked.txt && printf 'new file\n' > added.txt && printf '\\001\\002\\003\\004' > binary.bin`,
  );
  if (boundary.exitCode !== 0) throw new Error(JSON.stringify(boundary));
  await control.hibernate("handoff-smoke");
  await control.open("handoff-smoke");
  const handoff = await control.exportWorkspace("handoff-smoke");
  console.log(`patch=${handoff.patchPath}`);
  console.log(`PASS: tracked_only=yes baseline_immutable=yes binary_patch=yes cold_restore=yes source_drift_checked=yes patch_apply_check=yes host_not_applied=yes`);
  await control.hibernate("handoff-smoke");
} finally {
  await control.destroy("handoff-smoke");
}
NODE

cd "$SOURCE_ROOT"
[[ "$HOST_HASH_BEFORE" == "$(git hash-object tracked.txt binary.bin)" ]]
[[ ! -e added.txt ]]
printf 'PASS: host_unchanged=yes\n'
