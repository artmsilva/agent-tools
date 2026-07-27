import assert from "node:assert/strict";
import { mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { containerResourceNames, DrydockControlPlane } from "./control-plane.ts";
import {
  containerForceDeleteFailPath,
  containerRootfsPath,
  installFakeContainerCli,
} from "./fake-container-cli.ts";

async function setup(idleTimeoutMs: number = 40, onBackgroundError?: (error: Error, name: string) => void) {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-activity-state-"));
  const cliDir = await mkdtemp(join("/tmp", "pd-activity-cli-"));
  const containerExecutable = await installFakeContainerCli(cliDir);
  const controlPlane = new DrydockControlPlane({
    stateRoot,
    containerExecutable,
    idleTimeoutMs,
    onBackgroundError,
  });
  return { stateRoot, cliDir, controlPlane };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(10);
  }
}

async function missing(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
}

test("automatically hibernates an idle active Drydock", async () => {
  const { stateRoot, cliDir, controlPlane } = await setup();
  const identity = await controlPlane.create("alpha");
  const { container } = containerResourceNames(identity.id);

  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "echo durable > keep.txt");

  await waitFor(() => missing(join(cliDir, "c", container)));
  await assert.doesNotReject(stat(join(stateRoot, "alpha", "rootfs.tar")));
  await waitFor(async () => {
    try {
      await controlPlane.exec("alpha", "echo too-late");
      return false;
    } catch (error) {
      return /not active/.test((error as Error).message);
    }
  });
});

test("running commands hold an activity lease until completion", async () => {
  const { cliDir, controlPlane } = await setup(30);
  const identity = await controlPlane.create("alpha");
  const { container } = containerResourceNames(identity.id);
  await controlPlane.open("alpha");

  const running = controlPlane.exec("alpha", "sleep 0.1; echo done > keep.txt");
  await delay(60);
  await assert.doesNotReject(stat(join(cliDir, "c", container)));
  assert.equal((await running).exitCode, 0);
  await waitFor(() => missing(join(cliDir, "c", container)));
});

test("explicit task lease prevents hibernation until released", async () => {
  const { cliDir, controlPlane } = await setup(30);
  const identity = await controlPlane.create("alpha");
  const { container } = containerResourceNames(identity.id);
  await controlPlane.open("alpha");

  const lease = await controlPlane.acquireLease("alpha");
  await delay(70);
  await assert.doesNotReject(stat(join(cliDir, "c", container)));

  lease.release();
  await waitFor(() => missing(join(cliDir, "c", container)));
  assert.throws(() => lease.release(), /already released/);
});

test("leases and lifecycle transitions cannot race hibernation or destruction", async () => {
  const { controlPlane } = await setup(0);
  await controlPlane.create("alpha");
  await controlPlane.open("alpha");

  const lease = controlPlane.acquireLease("alpha");
  await assert.rejects(controlPlane.hibernate("alpha"), /active lease/);
  lease.release();

  const hibernating = controlPlane.hibernate("alpha");
  assert.throws(() => controlPlane.acquireLease("alpha"), /lifecycle transition/);
  await hibernating;

  const opening = controlPlane.open("alpha");
  await assert.rejects(controlPlane.destroy("alpha"), /lifecycle transition/);
  await opening;

  const destroying = controlPlane.destroy("alpha");
  assert.throws(() => controlPlane.acquireLease("alpha"), /lifecycle transition/);
  await destroying;
});

test("background hibernation failure is surfaced and keeps recoverable state", async () => {
  let reported: { error: Error; name: string } | undefined;
  const { stateRoot, cliDir, controlPlane } = await setup(30, (error, name) => {
    reported = { error, name };
  });
  const identity = await controlPlane.create("alpha");
  const { container } = containerResourceNames(identity.id);
  await controlPlane.open("alpha");
  const marker = containerForceDeleteFailPath(cliDir, container);
  await writeFile(marker, "fail");

  await waitFor(async () => reported !== undefined);

  assert.equal(reported?.name, "alpha");
  assert.match(reported?.error.message ?? "", /delete failed/);
  await assert.doesNotReject(stat(join(stateRoot, "alpha", "environment.json")));
  await assert.doesNotReject(stat(join(cliDir, "c", container)));

  await unlink(marker);
  await controlPlane.hibernate("alpha");
});
