import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DrydockSessionManager } from "./sessions.ts";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-drydock-sessions-"));
  const executable = join(directory, "container");
  await writeFile(
    executable,
    `#!/bin/bash
set -euo pipefail
STATE=${JSON.stringify(directory)}
printf '<%s>' "$@" >> "$STATE/args.log"
printf '\n' >> "$STATE/args.log"
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do [[ "\${args[$i]}" == tmux ]] && break; done
j=$((i+1))
[[ "\${args[$j]}" == -L ]] && j=$((j+2))
[[ "\${args[$j]}" == -C ]] && j=$((j+1))
cmd="\${args[$j]}"
case "$cmd" in
  list-sessions) [[ -f "$STATE/list" ]] && cat "$STATE/list" || { echo 'no server running' >&2; exit 1; } ;;
  capture-pane) cat "$STATE/capture" ;;
  display-message) [[ -f "$STATE/pane-dead" ]] && cat "$STATE/pane-dead" || echo 0 ;;
  attach-session)
    printf '%s\n' '%output %0 buffered\\040live\\015\\012'
    IFS= read -r line
    printf '%s\n' "$line" >> "$STATE/control.log"
    ;;
  *) : ;;
esac
`,
  );
  await chmod(executable, 0o755);
  return { directory, manager: new DrydockSessionManager({ containerExecutable: executable, container: "container-1" }) };
}

test("starts commands as argv in a detached tmux session", async () => {
  const { directory, manager } = await setup();

  const session = await manager.start("printf", ["hello; touch /tmp/escape"]);

  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(session.attached, false);
  const calls = await readFile(join(directory, "args.log"), "utf8");
  assert.match(calls, /<new-session><-d><-s><drydock-.*<--><sleep><infinity>/);
  assert.match(calls, /<respawn-pane><-k>.*<--><printf><hello; touch \/tmp\/escape>/);
  assert.match(calls, /<remain-on-exit><on>/);
  assert.match(calls, /<history-limit><10000>/);
});

test("lists only valid Drydock sessions deterministically", async () => {
  const { directory, manager } = await setup();
  await writeFile(
    join(directory, "list"),
    [
      "other-session\t1\t20",
      "drydock-not-an-id\t0\t20",
      "drydock-33333333-3333-4333-8333-333333333333\t0\t-1",
      "drydock-22222222-2222-4222-8222-222222222222\t0\t20",
      "drydock-11111111-1111-4111-8111-111111111111\t1\t10",
      "",
    ].join("\n"),
  );

  assert.deepEqual(await manager.list(), [
    { id: "11111111-1111-4111-8111-111111111111", attached: true, createdAt: "1970-01-01T00:00:10.000Z" },
    { id: "22222222-2222-4222-8222-222222222222", attached: false, createdAt: "1970-01-01T00:00:20.000Z" },
  ]);
});

test("rejects malformed caller input and invalid capture or resize bounds", async () => {
  const { manager } = await setup();

  assert.throws(() => manager.attach("../escape"), /Invalid Drydock session ID/);
  await assert.rejects(manager.capture("11111111-1111-4111-8111-111111111111", 10_001), /capture lines/);
  await assert.rejects(manager.resize("11111111-1111-4111-8111-111111111111", 0, 24), /columns/);
});

test("detects live and exited session processes", async () => {
  const { directory, manager } = await setup();
  const id = "11111111-1111-4111-8111-111111111111";

  assert.equal(await manager.isRunning(id), true);
  await writeFile(join(directory, "pane-dead"), "1\n");
  assert.equal(await manager.isRunning(id), false);
});

test("captures, resizes, stops, and detaches without killing the tmux session", async () => {
  const { directory, manager } = await setup();
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(directory, "capture"), "buffered output\n");

  assert.equal(await manager.capture(id, 50), "buffered output\n");
  await manager.resize(id, 120, 40);
  await manager.stop(id);
  const attached = manager.attach(id);
  let output = "";
  try {
    const liveOutput = new Promise<string>((resolve) =>
      attached.output.once("data", (chunk) => resolve(chunk.toString("utf8"))),
    );
    attached.input.write("x");
    output = await liveOutput;
  } finally {
    await delay(20);
    attached.detach();
    await attached.closed;
  }
  assert.equal(output, "buffered live\r\n");

  const calls = await readFile(join(directory, "args.log"), "utf8");
  assert.match(calls, /<capture-pane><-p>.*<-S><-50>/);
  assert.match(calls, /<resize-window>.*<-x><120><-y><40>/);
  assert.match(calls, /<kill-session><-t><drydock-/);
  assert.match(calls, /<exec><--interactive>.*<tmux><-L><pi-drydock><-C><attach-session>/);
  assert.match(await readFile(join(directory, "control.log"), "utf8"), /send-keys .* -H 78/);
});
