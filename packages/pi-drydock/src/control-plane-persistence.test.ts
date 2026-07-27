import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { containerResourceNames, DrydockControlPlane } from "./control-plane.ts";
import {
  containerForceDeleteFailPath,
  containerRootfsPath,
  installFakeContainerCli,
  lastExecInvocationPath,
} from "./fake-container-cli.ts";

const execFileAsync = promisify(execFile);

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-persistence-state-"));
  // Short prefix: a Unix domain socket test fixture needs the full rootfs
  // path to stay under the ~104 char sockaddr_un limit.
  const cliDir = await mkdtemp(join("/tmp", "pd-cli-"));
  const containerExecutable = await installFakeContainerCli(cliDir);
  const controlPlane = new DrydockControlPlane({ stateRoot, containerExecutable });
  return { stateRoot, cliDir, controlPlane };
}

async function rootfsFor(cliDir: string, controlPlane: DrydockControlPlane, name: string): Promise<string> {
  const identity = await controlPlane.get(name);
  const { container } = containerResourceNames(identity.id);
  return containerRootfsPath(cliDir, container);
}

function tarArchive(name: string, type: string = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, 0, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, header.reduce((sum, byte) => sum + byte, 0), 148, 8);
  return Buffer.concat([header, Buffer.alloc(1024)]);
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

test("roundtrips workspace content through open/exec/hibernate/open", async () => {
  const { cliDir, controlPlane } = await setup();
  await controlPlane.create("alpha");

  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "echo hello > keep.txt");
  await controlPlane.hibernate("alpha");

  await controlPlane.open("alpha");
  const result = await controlPlane.exec("alpha", "cat keep.txt");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello\n");

  const rootfs = await rootfsFor(cliDir, controlPlane, "alpha");
  assert.equal((await stat(rootfs)).isDirectory(), true);
});

test("hibernate excludes proc/sys/dev/run/tmp, sockets, and Pi auth.json", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "echo keepme > keep.txt");

  const rootfs = await rootfsFor(cliDir, controlPlane, "alpha");
  await mkdir(join(rootfs, "proc"), { recursive: true });
  await mkdir(join(rootfs, "sys"), { recursive: true });
  await mkdir(join(rootfs, "run"), { recursive: true });
  await mkdir(join(rootfs, "tmp"), { recursive: true });
  await mkdir(join(rootfs, "home", "node", ".pi", "agent"), { recursive: true });
  await writeFile(join(rootfs, "proc", "should-exclude"), "procdata");
  await writeFile(join(rootfs, "sys", "should-exclude"), "sysdata");
  await writeFile(join(rootfs, "run", "should-exclude"), "rundata");
  await writeFile(join(rootfs, "tmp", "should-exclude"), "tmpdata");
  await writeFile(join(rootfs, "home", "node", ".pi", "agent", "auth.json"), "secret");

  await controlPlane.hibernate("alpha");

  const rootTarPath = join(stateRoot, "alpha", "rootfs.tar");
  const { stdout } = await execFileAsync("tar", ["-tf", rootTarPath]);
  assert.match(stdout, /workspace\/keep\.txt/);
  assert.doesNotMatch(stdout, /proc\/should-exclude/);
  assert.doesNotMatch(stdout, /sys\/should-exclude/);
  assert.doesNotMatch(stdout, /run\/should-exclude/);
  assert.doesNotMatch(stdout, /tmp\/should-exclude/);
  assert.doesNotMatch(stdout, /auth\.json/);
});

test("hibernate excludes a socket file even outside the pruned directories", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "echo keepme > keep.txt");

  const rootfs = await rootfsFor(cliDir, controlPlane, "alpha");
  const socketPath = join(rootfs, "workspace", "test.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await controlPlane.hibernate("alpha");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const rootTarPath = join(stateRoot, "alpha", "rootfs.tar");
  const { stdout } = await execFileAsync("tar", ["-tf", rootTarPath]);
  assert.match(stdout, /workspace\/keep\.txt/);
  assert.doesNotMatch(stdout, /test\.sock/);
});

test("failed export preserves running compute and the prior snapshot", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "echo first > keep.txt");
  await controlPlane.hibernate("alpha");

  const rootTarPath = join(stateRoot, "alpha", "rootfs.tar");
  const priorSnapshot = await readFile(rootTarPath);

  await controlPlane.open("alpha");
  const identity = await controlPlane.get("alpha");
  const { container, network } = containerResourceNames(identity.id);
  const rootfs = containerRootfsPath(cliDir, container);
  await writeFile(join(rootfs, ".force-exec-fail"), "");

  await assert.rejects(controlPlane.hibernate("alpha"), /simulated exec failure/);

  assert.deepEqual(await readFile(rootTarPath), priorSnapshot);
  await assert.doesNotReject(stat(join(cliDir, "c", container)));
  await assert.doesNotReject(stat(join(cliDir, "n", network)));
});

test("corrupt snapshot fails open, cleans partial compute, and leaves the snapshot alone", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  await controlPlane.create("alpha");
  const rootTarPath = join(stateRoot, "alpha", "rootfs.tar");
  await writeFile(rootTarPath, "not a tar file");

  const identity = await controlPlane.get("alpha");
  const { container, network } = containerResourceNames(identity.id);

  await assert.rejects(controlPlane.open("alpha"));

  await assert.rejects(stat(join(cliDir, "c", container)));
  await assert.rejects(stat(join(cliDir, "n", network)));
  assert.equal(await readFile(rootTarPath, "utf8"), "not a tar file");
});

test("open rejects unsafe archive paths and entry types before restore", async () => {
  const { controlPlane, stateRoot } = await setup();
  await controlPlane.create("alpha");
  const archive = join(stateRoot, "alpha", "rootfs.tar");

  for (const [name, type, expected] of [
    ["../escape", "0", /path traversal/],
    ["/absolute", "0", /absolute path/],
    ["./home/node/.pi/agent/auth.json", "0", /excluded entry/],
    ["workspace/device", "3", /forbidden entry type/],
  ] as const) {
    await writeFile(archive, tarArchive(name, type));
    await assert.rejects(controlPlane.open("alpha"), expected);
  }
});

test("secure exec uses the unprivileged no-new-privileges wrapper", async () => {
  const { controlPlane, cliDir } = await setup();
  const identity = await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  await controlPlane.exec("alpha", "true");
  const { container } = containerResourceNames(identity.id);
  const invocation = await readFile(lastExecInvocationPath(cliDir, container), "utf8");

  assert.match(invocation, /--uid\n1000/);
  assert.match(invocation, /--gid\n1000/);
  assert.match(invocation, /--nnp/);
  assert.match(invocation, /--inh-caps=-all/);
  assert.match(invocation, /--ambient-caps=-all/);
});

test("container operations time out and clean partial resources", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-drydock-timeout-state-"));
  const cliDir = await mkdtemp(join("/tmp", "pd-slow-cli-"));
  const executable = join(cliDir, "container");
  await writeFile(executable, "#!/bin/sh\nsleep 10\n");
  await chmod(executable, 0o755);
  const controlPlane = new DrydockControlPlane({ stateRoot, containerExecutable: executable, operationTimeoutMs: 20 });
  await controlPlane.create("alpha");

  await assert.rejects(controlPlane.open("alpha"), /timed out/);
  assert.deepEqual(await controlPlane.list(), ["alpha"]);
});

test("destroy retains identity when active compute deletion fails", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  const identity = await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  const { container } = containerResourceNames(identity.id);
  const marker = containerForceDeleteFailPath(cliDir, container);
  await writeFile(marker, "fail");

  await assert.rejects(controlPlane.destroy("alpha"), /delete failed/);
  assert.deepEqual(await controlPlane.list(), ["alpha"]);
  await assert.doesNotReject(stat(join(stateRoot, "alpha", "environment.json")));

  await unlink(marker);
  await controlPlane.destroy("alpha");
});

test("destroy deletes active compute resources before removing metadata", async () => {
  const { controlPlane, stateRoot, cliDir } = await setup();
  await controlPlane.create("alpha");
  await controlPlane.open("alpha");
  const identity = await controlPlane.get("alpha");
  const { container, network } = containerResourceNames(identity.id);

  await assert.doesNotReject(stat(join(cliDir, "c", container)));
  await assert.doesNotReject(stat(join(cliDir, "n", network)));

  await controlPlane.destroy("alpha");

  await assert.rejects(stat(join(cliDir, "c", container)));
  await assert.rejects(stat(join(cliDir, "n", network)));
  await assert.rejects(stat(join(stateRoot, "alpha")));
  assert.deepEqual(await controlPlane.list(), []);
});
