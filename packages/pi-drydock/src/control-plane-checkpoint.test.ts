import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DrydockControlPlane } from "./control-plane.ts";
import { installFakeContainerCli } from "./fake-container-cli.ts";

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-checkpoint-state-"));
  const cliDir = await mkdtemp(join("/tmp", "pd-checkpoint-cli-"));
  const containerExecutable = await installFakeContainerCli(cliDir);
  const options = { stateRoot, containerExecutable, idleTimeoutMs: 0 };
  return {
    stateRoot,
    control: new DrydockControlPlane(options),
    restarted: new DrydockControlPlane(options),
  };
}

test("checkpoint captures active files without hibernating and restore rolls back", async () => {
  const { control } = await setup();
  await control.create("alpha");
  await control.open("alpha");
  await control.exec("alpha", "echo first > keep.txt");

  const checkpoint = await control.checkpoint("alpha");
  assert.match(checkpoint.id, /^[0-9a-f-]{36}$/);
  assert.equal((await control.listCheckpoints("alpha")).length, 1);
  await control.exec("alpha", "echo second > keep.txt");

  await control.restoreCheckpoint("alpha", checkpoint.id);
  await assert.rejects(control.exec("alpha", "cat keep.txt"), /not active/);
  await control.open("alpha");
  assert.equal((await control.exec("alpha", "cat keep.txt")).stdout, "first\n");
  await control.hibernate("alpha");
  await control.destroy("alpha");
});

test("inactive checkpoints survive a control-plane restart", async () => {
  const { control, restarted } = await setup();
  await control.create("alpha");
  await control.open("alpha");
  await control.exec("alpha", "echo durable > keep.txt");
  await control.hibernate("alpha");

  const checkpoint = await control.checkpoint("alpha");
  assert.deepEqual((await restarted.listCheckpoints("alpha")).map(({ id }) => id), [checkpoint.id]);
  await restarted.restoreCheckpoint("alpha", checkpoint.id);
  await restarted.open("alpha");
  assert.equal((await restarted.exec("alpha", "cat keep.txt")).stdout, "durable\n");
  await restarted.hibernate("alpha");
  await restarted.destroy("alpha");
});

test("corrupt checkpoint is rejected before active compute is discarded", async () => {
  const { stateRoot, control } = await setup();
  await control.create("alpha");
  await control.open("alpha");
  await control.exec("alpha", "echo safe > keep.txt");
  const checkpoint = await control.checkpoint("alpha");
  await writeFile(join(stateRoot, "alpha", "checkpoints", `${checkpoint.id}.tar`), "corrupt");

  await assert.rejects(control.restoreCheckpoint("alpha", checkpoint.id), /Corrupt Drydock archive/);
  assert.equal((await control.exec("alpha", "cat keep.txt")).stdout, "safe\n");
  await control.hibernate("alpha");
  await control.destroy("alpha");
});

test("checkpoint storage rejects symlink substitution", async () => {
  const { stateRoot, control } = await setup();
  await control.create("alpha");
  await control.open("alpha");
  await control.hibernate("alpha");
  const outside = await mkdtemp(join(tmpdir(), "pi-drydock-checkpoint-outside-"));
  const marker = join(outside, "marker");
  await writeFile(marker, "unchanged");
  await symlink(outside, join(stateRoot, "alpha", "checkpoints"));

  await assert.rejects(control.checkpoint("alpha"), /Invalid Drydock checkpoints path/);
  assert.equal(await readFile(marker, "utf8"), "unchanged");
  await control.destroy("alpha");
});

test("active task leases block checkpoint and restore", async () => {
  const { control } = await setup();
  await control.create("alpha");
  await control.open("alpha");
  await control.exec("alpha", "echo safe > keep.txt");
  const checkpoint = await control.checkpoint("alpha");
  const lease = control.acquireLease("alpha");

  await assert.rejects(control.checkpoint("alpha"), /active lease/);
  await assert.rejects(control.restoreCheckpoint("alpha", checkpoint.id), /active lease/);

  lease.release();
  await control.hibernate("alpha");
  await control.destroy("alpha");
});
