import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DrydockControlPlane } from "./control-plane.ts";

async function stateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-drydock-control-plane-"));
}

test("creates a stable named Drydock identity", async () => {
  const root = await stateRoot();
  const controlPlane = new DrydockControlPlane({ stateRoot: root });

  const identity = await controlPlane.create("project-alpha");
  assert.equal(identity.name, "project-alpha");
  assert.match(identity.id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(identity.createdAt).toISOString(), identity.createdAt);

  const metadataPath = join(root, "project-alpha", "environment.json");
  assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")), {
    schemaVersion: 1,
    ...identity,
  });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "project-alpha"))).mode & 0o777, 0o700);
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);

  await controlPlane.recordStartupTelemetry("project-alpha", {
    startedAt: "2026-07-27T10:00:00.000Z",
    durationMs: 321,
  });
  const telemetryPath = join(root, "project-alpha", "startup-telemetry.json");
  assert.deepEqual(JSON.parse(await readFile(telemetryPath, "utf8")), {
    schemaVersion: 1,
    startedAt: "2026-07-27T10:00:00.000Z",
    durationMs: 321,
  });
  assert.equal((await stat(telemetryPath)).mode & 0o777, 0o600);
});

test("rejects invalid Drydock names", async () => {
  const controlPlane = new DrydockControlPlane({ stateRoot: await stateRoot() });
  for (const name of ["", "../escape", "Uppercase", "trailing-", "a".repeat(64)]) {
    await assert.rejects(controlPlane.create(name), /Invalid Drydock name/);
  }
});

test("reserves a Drydock name for only one concurrent create", async () => {
  const controlPlane = new DrydockControlPlane({ stateRoot: await stateRoot() });
  const results = await Promise.allSettled([controlPlane.create("shared"), controlPlane.create("shared")]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  await assert.rejects(controlPlane.create("shared"), /Drydock already exists: shared/);
});

test("loads and lists named Drydocks deterministically", async () => {
  const controlPlane = new DrydockControlPlane({ stateRoot: await stateRoot() });

  await controlPlane.create("zulu");
  const alpha = await controlPlane.create("alpha");

  assert.deepEqual(await controlPlane.get("alpha"), alpha);
  assert.deepEqual(await controlPlane.list(), ["alpha", "zulu"]);
});

test("retains corrupt or newer metadata and fails closed", async () => {
  const root = await stateRoot();
  const controlPlane = new DrydockControlPlane({ stateRoot: root });
  const identity = await controlPlane.create("alpha");
  const metadataPath = join(root, "alpha", "environment.json");
  const newerMetadata = JSON.stringify({
    schemaVersion: 2,
    ...identity,
  });

  await writeFile(metadataPath, newerMetadata);
  await assert.rejects(controlPlane.get("alpha"), /Unsupported Drydock schema: 2/);
  assert.equal(await readFile(metadataPath, "utf8"), newerMetadata);

  await writeFile(metadataPath, "{");
  assert.deepEqual(await controlPlane.list(), ["alpha"]);
  await assert.rejects(controlPlane.get("alpha"), /Invalid Drydock metadata: alpha/);
  assert.equal(await readFile(metadataPath, "utf8"), "{");
});

test("atomically destroys valid or corrupt Drydock state", async () => {
  const root = await stateRoot();
  const controlPlane = new DrydockControlPlane({ stateRoot: root });
  await controlPlane.create("alpha");
  await writeFile(join(root, "alpha", "environment.json"), "{");

  await controlPlane.destroy("alpha");

  await assert.rejects(access(join(root, "alpha")), /ENOENT/);
  assert.deepEqual(await controlPlane.list(), []);
  assert.equal((await controlPlane.create("alpha")).name, "alpha");
  await assert.rejects(controlPlane.destroy("missing"), /Drydock not found: missing/);
});

test("cleans an orphaned destroy tombstone while listing", async () => {
  const root = await stateRoot();
  const tombstone = join(root, ".destroy-018f4f42-90d1-7c4a-b7a3-2f9ad1a1a111");
  await mkdir(tombstone);
  await writeFile(join(tombstone, "orphan"), "stale");
  const controlPlane = new DrydockControlPlane({ stateRoot: root });

  assert.deepEqual(await controlPlane.list(), []);
  await assert.rejects(access(tombstone), /ENOENT/);
});

test("rejects a symlinked state root", async () => {
  const parent = await stateRoot();
  const target = await stateRoot();
  const linkedRoot = join(parent, "linked-root");
  await symlink(target, linkedRoot);
  const controlPlane = new DrydockControlPlane({ stateRoot: linkedRoot });

  await assert.rejects(controlPlane.list(), /Invalid Drydock state root/);
  await assert.rejects(controlPlane.create("alpha"), /Invalid Drydock state root/);
});

test("destroy removes a swapped symlink without touching its target", async () => {
  const root = await stateRoot();
  const target = await stateRoot();
  const targetMetadata = join(target, "environment.json");
  await writeFile(targetMetadata, "keep");
  await symlink(target, join(root, "alpha"));

  await new DrydockControlPlane({ stateRoot: root }).destroy("alpha");

  assert.equal(await readFile(targetMetadata, "utf8"), "keep");
  await assert.rejects(access(join(root, "alpha")), /ENOENT/);
});
