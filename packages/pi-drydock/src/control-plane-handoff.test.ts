import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DrydockControlPlane } from "./control-plane.ts";
import { containerRootfsPath, installFakeContainerCli } from "./fake-container-cli.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function sourceRepository(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pi-drydock-handoff-source-"));
  await git(source, "init", "-q");
  await git(source, "config", "user.name", "Drydock Test");
  await git(source, "config", "user.email", "drydock@example.invalid");
  await writeFile(join(source, "tracked.txt"), "host baseline\n");
  await writeFile(join(source, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(source, "ignored.txt"), "host only\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await git(source, "add", "tracked.txt", "binary.bin", ".gitignore");
  await git(source, "commit", "-qm", "baseline");
  return realpath(source);
}

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-handoff-state-"));
  const cliRoot = await mkdtemp(join(tmpdir(), "pi-drydock-handoff-cli-"));
  const containerExecutable = await installFakeContainerCli(cliRoot);
  const control = new DrydockControlPlane({ stateRoot, containerExecutable, idleTimeoutMs: 0 });
  const identity = await control.create("handoff");
  await control.open("handoff");
  return { stateRoot, cliRoot, control, identity };
}

test("imports only tracked host files into immutable baseline and writable workspace", async () => {
  const source = await sourceRepository();
  const { stateRoot, cliRoot, control, identity } = await setup();

  const binding = await control.importWorkspace("handoff", source);

  assert.equal(binding.sourceRoot, source);
  assert.match(binding.sourceDigest, /^[0-9a-f]{64}$/);
  assert.match(binding.sourceHead, /^[0-9a-f]{40}$/);
  assert.equal(binding.trackedFiles, 3);
  const rootfs = containerRootfsPath(cliRoot, `drydock-${identity.id}`);
  assert.equal(await readFile(join(rootfs, "baseline/tracked.txt"), "utf8"), "host baseline\n");
  assert.equal(await readFile(join(rootfs, "workspace/tracked.txt"), "utf8"), "host baseline\n");
  assert.equal((await stat(join(rootfs, "baseline/tracked.txt"))).mode & 0o222, 0);
  assert.notEqual((await stat(join(rootfs, "workspace/tracked.txt"))).mode & 0o200, 0);
  await assert.rejects(readFile(join(rootfs, "workspace/ignored.txt")), /ENOENT/);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "host baseline\n");
  assert.equal((await stat(join(stateRoot, "handoff/workspace-binding.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(stateRoot, "handoff/workspace-binding.json"), "utf8")), {
    schemaVersion: 1,
    ...binding,
  });
  await assert.rejects(control.importWorkspace("handoff", source), /already bound/);
});

test("exports an immutable review patch without changing the bound host checkout", async () => {
  const source = await sourceRepository();
  const { stateRoot, control } = await setup();
  await control.importWorkspace("handoff", source);
  await control.hibernate("handoff");
  await control.open("handoff");
  const edit = await control.exec(
    "handoff",
    "printf 'guest edit\\n' > tracked.txt; printf 'new file\\n' > added.txt; printf '\\001\\002\\003\\004' > binary.bin",
  );
  assert.equal(edit.exitCode, 0);

  const handoff = await control.exportWorkspace("handoff");

  assert.equal(handoff.sourceRoot, source);
  assert.match(handoff.id, /^[0-9a-f-]{36}$/);
  assert.match(handoff.patchDigest, /^[0-9a-f]{64}$/);
  assert.equal(handoff.patchPath, join(stateRoot, "handoff", "handoffs", `${handoff.id}.patch`));
  assert.equal((await stat(handoff.patchPath)).mode & 0o777, 0o400);
  assert.equal((await stat(join(stateRoot, "handoff", "handoffs", `${handoff.id}.json`))).mode & 0o777, 0o600);
  const patch = await readFile(handoff.patchPath, "utf8");
  assert.match(patch, /--- a\/tracked\.txt/);
  assert.match(patch, /\+\+\+ b\/tracked\.txt/);
  assert.match(patch, /new file/);
  assert.match(patch, /GIT binary patch/);
  await execFileAsync("git", ["apply", "--check", "--binary", handoff.patchPath], { cwd: source });
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "host baseline\n");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "handoff", "handoffs", `${handoff.id}.json`), "utf8")).patchDigest, handoff.patchDigest);
});

test("rejects export after the bound host source drifts", async () => {
  const source = await sourceRepository();
  const { control } = await setup();
  await control.importWorkspace("handoff", source);
  await writeFile(join(source, "tracked.txt"), "host drift\n");

  await assert.rejects(control.exportWorkspace("handoff"), /source changed since import/);
});

test("rejects tracked symlinks before changing Guest workspace", async () => {
  const source = await sourceRepository();
  await symlink("tracked.txt", join(source, "linked.txt"));
  await git(source, "add", "linked.txt");
  const { cliRoot, control, identity } = await setup();

  await assert.rejects(control.importWorkspace("handoff", source), /unsupported tracked entry/);

  const rootfs = containerRootfsPath(cliRoot, `drydock-${identity.id}`);
  await assert.rejects(readFile(join(rootfs, "workspace/tracked.txt")), /ENOENT/);
});
