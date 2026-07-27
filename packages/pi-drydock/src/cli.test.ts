import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runDrydockCli } from "./cli.ts";
import { DrydockControlPlane } from "./control-plane.ts";
import { installFakeContainerCli } from "./fake-container-cli.ts";
import type { HostModelConnector } from "./model-connector.ts";

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

test("create installs tracked secret-free dotfiles inside the Guest", async () => {
  const source = await repository();
  const dotfiles = await repository();
  await writeFile(join(dotfiles, ".bashrc"), "export DRYDOCK_DOTFILES_READY=1\n");
  await writeFile(join(dotfiles, "install.sh"), "#!/bin/sh\ntouch .dotfiles-installed\n", { mode: 0o755 });
  await execFileAsync("git", ["add", ".bashrc", "install.sh"], { cwd: dotfiles });
  await execFileAsync("git", ["commit", "-qm", "add dotfiles"], { cwd: dotfiles });

  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-state-"));
  const fakeRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-container-"));
  const containerExecutable = await installFakeContainerCli(fakeRoot);
  const control = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  const stdout = output();
  const options = {
    control,
    stdout: stdout.stream,
    dotfilesRoot: dotfiles,
    dotfilesInstallCommand: "./install.sh",
  };

  assert.equal(await runDrydockCli(["create", "dotfiles", source], options), 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.dotfiles.trackedFiles, 3);
  assert.equal(result.dotfiles.installCommandRan, true);
  stdout.clear();

  assert.equal(await runDrydockCli([
    "exec",
    "dotfiles",
    "test \"$(cat ../home/node/.bashrc)\" = 'export DRYDOCK_DOTFILES_READY=1' && test -f ../home/node/.dotfiles-installed",
  ], options), 0);
  await control.destroy("dotfiles");
});

test("create rejects credential-bearing dotfile paths", async () => {
  const source = await repository();
  const dotfiles = await repository();
  await mkdir(join(dotfiles, ".ssh"));
  await writeFile(join(dotfiles, ".ssh", "config"), "Host *\n");
  await execFileAsync("git", ["add", ".ssh/config"], { cwd: dotfiles });
  await execFileAsync("git", ["commit", "-qm", "add unsafe dotfile"], { cwd: dotfiles });

  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-reject-state-"));
  const fakeRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-reject-container-"));
  const containerExecutable = await installFakeContainerCli(fakeRoot);
  const control = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  await assert.rejects(
    runDrydockCli(["create", "unsafe-dotfiles", source], { control, dotfilesRoot: dotfiles }),
    /forbidden credential path: \.ssh\/config/,
  );
  assert.deepEqual(await control.list(), []);
});

test("create rejects literal secrets in otherwise allowed shell dotfiles", async () => {
  const source = await repository();
  const dotfiles = await repository();
  await writeFile(join(dotfiles, ".bashrc"), "export GH_TOKEN=ghp_not-a-real-token\n");
  await execFileAsync("git", ["add", ".bashrc"], { cwd: dotfiles });
  await execFileAsync("git", ["commit", "-qm", "add unsafe shell profile"], { cwd: dotfiles });

  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-secret-state-"));
  const fakeRoot = await mkdtemp(join(tmpdir(), "pi-drydock-dotfiles-secret-container-"));
  const containerExecutable = await installFakeContainerCli(fakeRoot);
  const control = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  await assert.rejects(
    runDrydockCli(["create", "secret-dotfiles", source], { control, dotfilesRoot: dotfiles }),
    /may contain secret material: \.bashrc/,
  );
  assert.deepEqual(await control.list(), []);
});

test("use selects a bound Drydock for name-free foreground entry", async () => {
  const source = await repository();
  const events: string[] = [];
  let startupTelemetry = { startedAt: "", durationMs: -1 };
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
    runForeground: async (
      name: string,
      command: string,
      args: string[],
      options: { environment?: Record<string, string>; onSpawn?: () => void },
    ) => {
      events.push(`foreground:${name}:${command}:${args.join(" ")}:${options.environment?.PATH}`);
      options.onSpawn!();
      return 0;
    },
    recordStartupTelemetry: async (name: string, telemetry: { startedAt: string; durationMs: number }) => {
      events.push(`telemetry:${name}`);
      startupTelemetry = telemetry;
    },
    hibernate: async (name: string) => events.push(`hibernate:${name}`),
    checkpoint: async (name: string) => {
      events.push(`checkpoint:${name}`);
      return { id: "00000000-0000-4000-8000-000000000001", createdAt: "2099-01-01T00:00:00.000Z", sizeBytes: 1 };
    },
  } as unknown as DrydockControlPlane;
  const stdout = output();
  const options = { control, cwd: source, stdout: stdout.stream, tty: true, modelConnector: fakeModelConnector() };

  assert.equal(await runDrydockCli(["use", "alpha"], options), 0);
  assert.equal(stdout.read(), "alpha\n");
  stdout.clear();
  assert.equal((await execFileAsync("git", ["config", "--local", "--get", "pi-drydock.name"], { cwd: source })).stdout.trim(), "alpha");
  assert.equal((await execFileAsync("git", ["status", "--short"], { cwd: source })).stdout, "");

  assert.equal(await runDrydockCli(["enter"], options), 0);
  assert.deepEqual(events.slice(0, 3), [
    "open:alpha",
    "connector:open",
    "foreground:alpha:/bin/bash:-i:/run/pi-drydock/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ]);
  assert.deepEqual(events.slice(-2), ["connector:close", "hibernate:alpha"]);
  assert.equal(events.includes("telemetry:alpha"), true);
  assert.equal(Number.isNaN(Date.parse(startupTelemetry.startedAt)), false);
  assert.equal(startupTelemetry.durationMs >= 0, true);

  assert.equal(await runDrydockCli(["checkpoint"], options), 0);
  assert.equal(events.at(-1), "checkpoint:alpha");
});

test("enter reports Guest Pi lifecycle only to the current Herdr pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-drydock-herdr-"));
  const log = join(root, "calls.txt");
  const executable = join(root, "herdr");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  await execFileAsync("chmod", ["+x", executable]);

  const states = ["idle\n", "working\n", ""];
  const control = {
    open: async () => undefined,
    openConnector: async () => ({ expiresAt: "2099-01-01T00:00:00.000Z", close: async () => undefined }),
    exec: async () => ({ stdout: states.shift() ?? "", stderr: "", exitCode: 0 }),
    runForeground: async () => new Promise<number>((resolve) => setTimeout(() => resolve(0), 700)),
    hibernate: async () => undefined,
  } as unknown as DrydockControlPlane;

  assert.equal(await runDrydockCli(["enter", "alpha"], {
    control,
    tty: true,
    herdr: { executable, paneId: "pane-current" },
    herdrPollIntervalMs: 5,
    modelConnector: fakeModelConnector(),
  }), 0);

  const calls = await readFile(log, "utf8");
  assert.match(calls, /pane report-agent pane-current .*--state idle/);
  assert.match(calls, /pane report-agent pane-current .*--state working/);
  assert.match(calls, /pane release-agent pane-current/);
  assert.doesNotMatch(calls, /pane-(?!current)|--source (?!drydock:pi)|--agent (?!pi)/);
});

function fakeModelConnector(): HostModelConnector {
  return {
    catalog: {
      providers: [{
        id: "test-provider",
        name: "Test Provider",
        models: [{
          id: "test-model",
          name: "Test Model",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        }],
      }],
      defaultModel: { provider: "test-provider", model: "test-model" },
    },
    handleRequest: async () => new Response(),
  };
}

test("host CLI reviews queued GitHub write requests", async () => {
  const calls: string[] = [];
  const request = { id: "review-1", status: "pending" };
  const control = {
    listGitHubReviewRequests: async (name: string) => {
      calls.push(`list:${name}`);
      return [request];
    },
    getGitHubReviewRequest: async (name: string, id: string) => {
      calls.push(`inspect:${name}:${id}`);
      return request;
    },
    approveGitHubReviewRequest: async (name: string, id: string) => {
      calls.push(`approve:${name}:${id}`);
      return { ...request, status: "approved" };
    },
    rejectGitHubReviewRequest: async (name: string, id: string) => {
      calls.push(`reject:${name}:${id}`);
      return { ...request, status: "rejected" };
    },
  } as unknown as DrydockControlPlane;
  const stdout = output();
  const options = { control, stdout: stdout.stream };

  assert.equal(await runDrydockCli(["github", "requests", "alpha"], options), 0);
  assert.match(stdout.read(), /review-1/);
  stdout.clear();
  assert.equal(await runDrydockCli(["github", "inspect", "alpha", "review-1"], options), 0);
  assert.equal(await runDrydockCli(["github", "approve", "alpha", "review-1"], options), 0);
  assert.equal(await runDrydockCli(["github", "reject", "alpha", "review-1"], options), 0);
  assert.deepEqual(calls, [
    "list:alpha",
    "inspect:alpha:review-1",
    "approve:alpha:review-1",
    "reject:alpha:review-1",
  ]);
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
  assert.match(stdout.read(), /enter \[name\].*measure startup/);
  assert.match(stdout.read(), /docs \[topic\]/);
  assert.doesNotMatch(stdout.read(), /run <name>|attach|capture|resize|sessions/);
  stdout.clear();
  assert.equal(await runDrydockCli(["help", "dotfiles"], { stdout: stdout.stream }), 0);
  assert.match(stdout.read(), /dedicated, secret-free Git repository/);
  stdout.clear();
  assert.equal(await runDrydockCli(["docs", "telemetry"], { stdout: stdout.stream }), 0);
  assert.match(stdout.read(), /startup-telemetry\.json/);
  stdout.clear();
  assert.equal(await runDrydockCli(["help", "github"], { stdout: stdout.stream }), 0);
  assert.match(stdout.read(), /repo:read/);
  await assert.rejects(runDrydockCli(["docs", "unknown"], { stdout: stdout.stream }), /Unknown Drydock docs topic/);
  await assert.rejects(runDrydockCli(["enter", "alpha"], { tty: false }), /requires an interactive terminal/);
  await assert.rejects(runDrydockCli(["exec"], { stdout: stdout.stream }), /one quoted argument/);
});
