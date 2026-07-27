import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runDrydockCli } from "./cli.ts";
import { DrydockControlPlane } from "./control-plane.ts";
import { installFakeContainerCli } from "./fake-container-cli.ts";

const execFileAsync = promisify(execFile);

function output() {
  let value = "";
  return {
    stream: { write: (chunk: string | Uint8Array) => (value += chunk.toString()) },
    read: () => value,
    clear: () => (value = ""),
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-drydock-cli-source-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Drydock Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "drydock@example.invalid"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return realpath(root);
}

test("stable CLI completes a cold lifecycle and emits a reviewed handoff", async () => {
  const source = await repository();
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-cli-state-"));
  const fakeRoot = await mkdtemp(join(tmpdir(), "pi-drydock-cli-container-"));
  const containerExecutable = await installFakeContainerCli(fakeRoot);
  const control = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  const stdout = output();
  const stderr = output();
  const options = { control, stdout: stdout.stream, stderr: stderr.stream };

  assert.equal(await runDrydockCli(["create", "alpha", source], options), 0);
  assert.equal(JSON.parse(stdout.read()).name, "alpha");
  stdout.clear();

  assert.equal(await runDrydockCli(["exec", "alpha", "printf 'guest edit\\n' > tracked.txt"], options), 0);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "baseline\n");

  assert.equal(await runDrydockCli(["checkpoint", "alpha"], options), 0);
  const checkpoint = JSON.parse(stdout.read());
  assert.match(checkpoint.id, /^[0-9a-f-]{36}$/);
  stdout.clear();

  assert.equal(await runDrydockCli(["export", "alpha"], options), 0);
  const handoff = JSON.parse(stdout.read());
  assert.match(await readFile(handoff.patchPath, "utf8"), /guest edit/);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "baseline\n");
  stdout.clear();

  assert.equal(await runDrydockCli(["checkpoints", "alpha"], options), 0);
  assert.deepEqual(JSON.parse(stdout.read()).map(({ id }: { id: string }) => id), [checkpoint.id]);
  stdout.clear();

  await control.open("alpha");
  const restarted = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  assert.equal(await runDrydockCli(["reconcile"], { ...options, control: restarted }), 0);
  assert.deepEqual(JSON.parse(stdout.read()).hibernated, ["alpha"]);
  stdout.clear();

  assert.equal(await runDrydockCli(["destroy", "alpha"], { ...options, control: restarted }), 0);
  assert.deepEqual(await restarted.list(), []);
});

test("use selects a bound Drydock for name-free foreground entry", async () => {
  const source = await repository();
  const events: string[] = [];
  const control = {
    getWorkspaceBinding: async () => ({ sourceRoot: source }),
    open: async (name: string) => events.push(`open:${name}`),
    openConnector: async () => {
      events.push("connector:open");
      return {
        expiresAt: "2099-01-01T00:00:00.000Z",
        close: async () => {
          events.push("connector:close");
        },
      };
    },
    runForeground: async (name: string, command: string, args: string[]) => {
      events.push(`foreground:${name}:${command}:${args.join(" ")}`);
      return 0;
    },
    hibernate: async (name: string) => events.push(`hibernate:${name}`),
    checkpoint: async (name: string) => {
      events.push(`checkpoint:${name}`);
      return { id: "00000000-0000-4000-8000-000000000001", createdAt: "2099-01-01T00:00:00.000Z", sizeBytes: 1 };
    },
  } as unknown as DrydockControlPlane;
  const stdout = output();
  const options = { control, cwd: source, stdout: stdout.stream, tty: true };

  assert.equal(await runDrydockCli(["use", "alpha"], options), 0);
  assert.equal(stdout.read(), "alpha\n");
  stdout.clear();
  assert.equal((await execFileAsync("git", ["config", "--local", "--get", "pi-drydock.name"], { cwd: source })).stdout.trim(), "alpha");
  assert.equal((await execFileAsync("git", ["status", "--short"], { cwd: source })).stdout, "");

  assert.equal(await runDrydockCli(["enter"], options), 0);
  assert.deepEqual(events.slice(0, 3), [
    "open:alpha",
    "connector:open",
    "foreground:alpha:/bin/bash:-i",
  ]);
  assert.deepEqual(events.slice(-2), ["connector:close", "hibernate:alpha"]);

  assert.equal(await runDrydockCli(["checkpoint"], options), 0);
  assert.equal(events.at(-1), "checkpoint:alpha");
});

test("setup starts Apple services and builds the Guest image", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-drydock-setup-"));
  const log = join(root, "calls.txt");
  const executable = join(root, "container");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  await execFileAsync("chmod", ["+x", executable]);

  assert.equal(await runDrydockCli(["setup"], { containerExecutable: executable }), 0);
  assert.match(await readFile(log, "utf8"), /^system start\nbuild .*pi-drydock-pi:latest/m);
});

test("CLI exposes foreground-only help and rejects incomplete commands", async () => {
  const stdout = output();
  assert.equal(await runDrydockCli([], { stdout: stdout.stream }), 0);
  assert.match(stdout.read(), /enter \[name\]/);
  assert.doesNotMatch(stdout.read(), /run <name>|attach|capture|resize|sessions/);
  await assert.rejects(runDrydockCli(["enter", "alpha"], { tty: false }), /requires an interactive terminal/);
  await assert.rejects(runDrydockCli(["exec"], { stdout: stdout.stream }), /one quoted argument/);
});
