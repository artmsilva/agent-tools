import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containerResourceNames, DrydockControlPlane } from "./control-plane.ts";
import { containerRootfsPath, installFakeContainerCli } from "./fake-container-cli.ts";

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-reconcile-state-"));
  const cliDir = await mkdtemp(join("/tmp", "pd-reconcile-cli-"));
  const containerExecutable = await installFakeContainerCli(cliDir);
  const options = { stateRoot, containerExecutable, idleTimeoutMs: 0 };
  return {
    stateRoot,
    cliDir,
    first: new DrydockControlPlane(options),
    restarted: new DrydockControlPlane(options),
  };
}

async function missing(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
}

test("restart reconciliation snapshots live compute before making it inactive", async () => {
  const { cliDir, first, restarted } = await setup();
  const identity = await first.create("alpha");
  const { container } = containerResourceNames(identity.id);
  await first.open("alpha");
  await first.exec("alpha", "echo recovered > keep.txt");

  const result = await restarted.reconcile();

  assert.deepEqual(result, { hibernated: ["alpha"], cleanedNetworks: [], removedTemporarySnapshots: 0 });
  assert.equal(await missing(join(cliDir, "c", container)), true);
  await restarted.open("alpha");
  assert.equal((await restarted.exec("alpha", "cat keep.txt")).stdout, "recovered\n");
  await restarted.hibernate("alpha");
  await restarted.destroy("alpha");
});

test("restart reconciliation removes network-only debris and stale snapshot temps", async () => {
  const { stateRoot, cliDir, first, restarted } = await setup();
  const identity = await first.create("alpha");
  const { container, network } = containerResourceNames(identity.id);
  await first.open("alpha");
  await rm(join(cliDir, "c", container), { recursive: true });
  const stale = join(stateRoot, "alpha", ".rootfs-crashed.tar.tmp");
  await writeFile(stale, "partial", { mode: 0o600 });

  const result = await restarted.reconcile();

  assert.deepEqual(result, { hibernated: [], cleanedNetworks: ["alpha"], removedTemporarySnapshots: 1 });
  assert.equal(await missing(join(cliDir, "n", network)), true);
  assert.equal(await missing(stale), true);
  await restarted.destroy("alpha");
});

test("restart reconciliation fails closed when live compute cannot be snapshotted", async () => {
  const { stateRoot, cliDir, first, restarted } = await setup();
  const identity = await first.create("alpha");
  const { container } = containerResourceNames(identity.id);
  await first.open("alpha");
  const failureMarker = join(containerRootfsPath(cliDir, container), ".force-exec-fail");
  await writeFile(failureMarker, "fail");
  const stale = join(stateRoot, "alpha", ".rootfs-crashed.tar.tmp");
  await writeFile(stale, "partial", { mode: 0o600 });

  await assert.rejects(restarted.reconcile(), /Drydock reconciliation failed/);

  await assert.doesNotReject(stat(join(cliDir, "c", container)));
  await assert.doesNotReject(stat(join(stateRoot, "alpha", "environment.json")));
  await assert.doesNotReject(stat(stale));
  await unlink(failureMarker);
  await restarted.hibernate("alpha");
  await restarted.destroy("alpha");
});
