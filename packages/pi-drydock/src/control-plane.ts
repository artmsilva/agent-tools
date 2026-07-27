import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";

const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOMBSTONE_PATTERN = /^\.destroy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION = 1;

// ponytail: one timeout knob for every container invocation, including the
// full-transfer export/restore streams; split per-operation budgets if a
// slow op and a fast op ever fight over the same default.
const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60_000;
const STDERR_CAP_BYTES = 64 * 1024;
// ponytail: bounded scan so a hostile/corrupt archive can't force an
// unbounded listing pass; raise if a legitimate rootfs ever has more entries.
const MAX_ARCHIVE_ENTRIES = 200_000;
// ls(1)/tar -tv leading type char: b=block device, c=char device, p=fifo, s=socket.
const FORBIDDEN_ARCHIVE_TYPE_CHARS = new Set(["b", "c", "p", "s"]);

export interface DrydockIdentity {
  id: string;
  name: string;
  createdAt: string;
}

interface EnvironmentMetadataV1 extends DrydockIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
}

export interface DrydockControlPlaneOptions {
  stateRoot?: string;
  containerExecutable?: string;
  /** Overall timeout for every container invocation (network/create/start/exec/export/restore/delete), including the full streamed transfer. Default 5 minutes. */
  operationTimeoutMs?: number;
}

export interface DrydockExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ROOT_TAR_NAME = "rootfs.tar";
const GUEST_UID = "1000";
const GUEST_GID = "1000";
const DRYDOCK_INSIDE_IMAGE = "pi-drydock-pi:latest";
// ponytail: relative paths (cwd=/) so restore is just `tar -xf -C /`, and so a
// fake exec sandbox (no chroot) can model this against a plain directory too.
const GUEST_AUTH_PATH = "./home/node/.pi/agent/auth.json";
const EXCLUDED_ROOT_PATHS = ["./proc", "./sys", "./dev", "./run", "./tmp", GUEST_AUTH_PATH];
// A full-root persistence snapshot intentionally retains whatever secrets the
// guest itself created (there is no general credential blocklist); the one
// enforced, tested boundary is that the Pi agent's own auth.json never
// leaves the guest. Do not read the exclusion list below as a security
// scrubber for guest-created files.
const EXPORT_ROOT_SCRIPT = [
  `set -e`,
  `LIST="/tmp/.drydock-export-$$.list"`,
  `trap 'rm -f "$LIST"' EXIT`,
  `find . \\( ${EXCLUDED_ROOT_PATHS.map((path) => `-path ${path}`).join(" -o ")} \\) -prune \\`,
  `  -o \\( -type s -o -type b -o -type c -o -type p \\) -prune \\`,
  `  -o -print0 > "$LIST"`,
  `tar --null --no-recursion -T "$LIST" -cf -`,
].join("\n");
const RESTORE_ROOT_SCRIPT = "tar -xf -";

export function containerResourceNames(id: string): { container: string; network: string } {
  const container = `drydock-${id}`;
  return { container, network: `${container}-net` };
}

export class DrydockControlPlane {
  readonly #stateRoot: string;
  readonly #executable: string;
  readonly #operationTimeoutMs: number;

  constructor(options: DrydockControlPlaneOptions = {}) {
    this.#stateRoot =
      options.stateRoot ?? join(homedir(), "Library", "Application Support", "pi-drydock", "environments");
    this.#executable = options.containerExecutable ?? "container";
    this.#operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  }

  async open(name: string): Promise<void> {
    assertName(name);
    const identity = await this.get(name);
    const { container, network } = containerResourceNames(identity.id);
    const rootTarPath = join(this.#stateRoot, name, ROOT_TAR_NAME);
    const timeoutMs = this.#operationTimeoutMs;

    await runContainer(this.#executable, ["network", "create", "--internal", network], undefined, timeoutMs);
    try {
      await runContainer(this.#executable, buildOpenArgs(container, network), undefined, timeoutMs);
      await runContainer(this.#executable, ["start", container], undefined, timeoutMs);
      if (await pathExists(rootTarPath)) {
        await validateArchive(rootTarPath, timeoutMs);
        await runContainerRestoreFromFile(
          this.#executable,
          [
            "exec",
            "--interactive",
            "--uid",
            "0",
            "--gid",
            "0",
            "--workdir",
            "/",
            container,
            "/bin/sh",
            "-lc",
            RESTORE_ROOT_SCRIPT,
          ],
          rootTarPath,
          timeoutMs,
        );
      }
    } catch (error) {
      try {
        await deleteComputeResources(this.#executable, container, network, timeoutMs);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Drydock open failed and cleanup also failed");
      }
      throw error;
    }
  }

  async exec(name: string, command: string): Promise<DrydockExecResult> {
    assertName(name);
    const identity = await this.get(name);
    const { container } = containerResourceNames(identity.id);
    // Privilege is dropped by the container runtime's own --uid/--gid before
    // this process ever starts, so setpriv (already running as uid 1000) can
    // only shed bits it holds: --nnp blocks future setuid-binary escalation,
    // --inh-caps=-all/--ambient-caps=-all clear what a child could inherit.
    // Deliberately no --bounding-set flag: dropping the bounding set itself
    // requires CAP_SETPCAP, which a uid-1000 process never has, so adding it
    // would make every exec() fail outright rather than harden anything.
    const result = await spawnContainer(
      this.#executable,
      [
        "exec",
        "--uid",
        GUEST_UID,
        "--gid",
        GUEST_GID,
        "--workdir",
        "/workspace",
        container,
        "/bin/setpriv",
        "--nnp",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "/bin/sh",
        "-lc",
        command,
      ],
      undefined,
      this.#operationTimeoutMs,
    );
    return { stdout: result.stdout.toString("utf8"), stderr: result.stderr, exitCode: result.exitCode };
  }

  async hibernate(name: string): Promise<void> {
    assertName(name);
    const identity = await this.get(name);
    const { container, network } = containerResourceNames(identity.id);
    const environmentDirectory = join(this.#stateRoot, name);
    const rootTarPath = join(environmentDirectory, ROOT_TAR_NAME);
    const tempTarPath = join(environmentDirectory, `.rootfs-${randomUUID()}.tar.tmp`);
    const timeoutMs = this.#operationTimeoutMs;

    try {
      await runContainerExportToFile(
        this.#executable,
        ["exec", "--uid", "0", "--gid", "0", "--workdir", "/", container, "/bin/sh", "-lc", EXPORT_ROOT_SCRIPT],
        tempTarPath,
        timeoutMs,
      );
      await validateArchive(tempTarPath, timeoutMs);
    } catch (error) {
      await rm(tempTarPath, { force: true });
      throw error;
    }

    await rename(tempTarPath, rootTarPath);
    await syncDirectory(environmentDirectory);

    await deleteComputeResources(this.#executable, container, network, timeoutMs);
  }

  async create(name: string): Promise<DrydockIdentity> {
    assertName(name);
    await prepareStateRoot(this.#stateRoot);
    const identity = createIdentity(name);
    const environmentDirectory = await reserveEnvironmentDirectory(this.#stateRoot, name);
    try {
      await writeMetadata(environmentDirectory, identity);
      return identity;
    } catch (error) {
      await cleanupFailedCreate(environmentDirectory, identity.id);
      throw error;
    }
  }

  async get(name: string): Promise<DrydockIdentity> {
    assertName(name);
    try {
      await assertStateRoot(this.#stateRoot);
      return await readIdentity(this.#stateRoot, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Drydock not found: ${name}`);
      throw error;
    }
  }

  async destroy(name: string): Promise<void> {
    assertName(name);
    await assertStateRoot(this.#stateRoot);
    const environmentDirectory = join(this.#stateRoot, name);
    try {
      await lstat(environmentDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Drydock not found: ${name}`);
      throw error;
    }
    await this.#deleteComputeResourcesBestEffort(environmentDirectory);
    const tombstone = join(this.#stateRoot, `.destroy-${randomUUID()}`);
    await rename(environmentDirectory, tombstone);
    await syncDirectory(this.#stateRoot);
    await rm(tombstone, { recursive: true });
    await syncDirectory(this.#stateRoot);
  }

  async list(): Promise<string[]> {
    let entries: Dirent[];
    try {
      await assertStateRoot(this.#stateRoot);
      entries = await readdir(this.#stateRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    await cleanupTombstones(this.#stateRoot, entries);
    return readNames(entries);
  }

  // ponytail: metadata may be corrupt or unreadable, in which case there is
  // no id to look up and nothing to clean up — tolerate that. A readable id
  // whose compute resources genuinely fail to delete must NOT be swallowed:
  // propagate so destroy() leaves the metadata in place for a retry instead
  // of tombstoning it out from under still-running compute.
  async #deleteComputeResourcesBestEffort(environmentDirectory: string): Promise<void> {
    let id: unknown;
    try {
      const raw = await readFile(join(environmentDirectory, "environment.json"), "utf8");
      id = JSON.parse(raw)?.id;
    } catch {
      return;
    }
    if (typeof id !== "string") return;
    const { container, network } = containerResourceNames(id);
    await deleteComputeResources(this.#executable, container, network, this.#operationTimeoutMs);
  }
}

function createIdentity(name: string): DrydockIdentity {
  const identity = { id: randomUUID(), name, createdAt: new Date().toISOString() };
  if (!ID_PATTERN.test(identity.id)) throw new Error(`Invalid Drydock ID: ${identity.id}`);
  return identity;
}

async function reserveEnvironmentDirectory(stateRoot: string, name: string): Promise<string> {
  const path = join(stateRoot, name);
  try {
    await mkdir(path, { mode: 0o700 });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Drydock already exists: ${name}`);
    throw error;
  }
}

async function writeMetadata(environmentDirectory: string, identity: DrydockIdentity): Promise<void> {
  const metadata: EnvironmentMetadataV1 = { schemaVersion: SCHEMA_VERSION, ...identity };
  const temporaryPath = join(environmentDirectory, `.environment-${identity.id}.tmp`);
  const metadataPath = join(environmentDirectory, "environment.json");
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, metadataPath);
  await syncDirectory(environmentDirectory);
}

async function cleanupFailedCreate(environmentDirectory: string, id: string): Promise<void> {
  await unlink(join(environmentDirectory, `.environment-${id}.tmp`)).catch(ignoreMissing);
  await rmdir(environmentDirectory).catch(ignoreMissing);
}

async function readIdentity(stateRoot: string, name: string): Promise<DrydockIdentity> {
  const environmentDirectory = join(stateRoot, name);
  const metadataPath = join(environmentDirectory, "environment.json");
  const [directory, metadataFile] = await Promise.all([lstat(environmentDirectory), lstat(metadataPath)]);
  assertEnvironmentDirectory(directory, name);
  assertMetadataFile(metadataFile, name);
  return parseMetadata(await readFile(metadataPath, "utf8"), name);
}

function assertEnvironmentDirectory(state: Stats, name: string): void {
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`Invalid Drydock metadata path: ${name}`);
}

function assertMetadataFile(state: Stats, name: string): void {
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`Invalid Drydock metadata path: ${name}`);
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Drydock name: ${name}`);
  }
}

function parseMetadata(text: string, expectedName: string): DrydockIdentity {
  const metadata = parseJson(text, expectedName);
  assertJsonObject(metadata, expectedName);
  assertSchema(metadata.schemaVersion, expectedName);
  return {
    id: readId(metadata.id, expectedName),
    name: readName(metadata.name, expectedName),
    createdAt: readCreatedAt(metadata.createdAt, expectedName),
  };
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidMetadata(name);
  }
}

function assertJsonObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMetadata(name);
}

function assertSchema(value: unknown, name: string): void {
  if (typeof value !== "number") throw invalidMetadata(name);
  if (value !== SCHEMA_VERSION) throw new Error(`Unsupported Drydock schema: ${value}`);
}

function readId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalidMetadata(name);
  return value;
}

function readName(value: unknown, expectedName: string): string {
  if (value !== expectedName) throw invalidMetadata(expectedName);
  return expectedName;
}

function readCreatedAt(value: unknown, name: string): string {
  if (!isIsoDate(value)) throw invalidMetadata(name);
  return value;
}

function invalidMetadata(name: string): Error {
  return new Error(`Invalid Drydock metadata: ${name}`);
}

async function prepareStateRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertStateRoot(path);
  await chmod(path, 0o700);
  await cleanupTombstones(path, await readdir(path, { withFileTypes: true }));
}

async function cleanupTombstones(stateRoot: string, entries: Dirent[]): Promise<void> {
  const tombstones = entries.filter(({ name }) => TOMBSTONE_PATTERN.test(name));
  await Promise.all(tombstones.map(({ name }) => rm(join(stateRoot, name), { recursive: true, force: true })));
  if (tombstones.length > 0) await syncDirectory(stateRoot);
}

function readNames(entries: Dirent[]): string[] {
  const names = entries.filter(({ name }) => !TOMBSTONE_PATTERN.test(name)).map(readRegistryName);
  names.sort();
  return names;
}

function readRegistryName(entry: Dirent): string {
  if (!entry.isDirectory() || entry.isSymbolicLink() || !NAME_PATTERN.test(entry.name)) {
    throw new Error(`Invalid Drydock registry entry: ${entry.name}`);
  }
  return entry.name;
}

async function assertStateRoot(path: string): Promise<void> {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`Invalid Drydock state root: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function buildOpenArgs(container: string, network: string): string[] {
  const bootstrap = "ip link set eth0 down; exec sleep infinity";
  return [
    "create",
    "--name",
    container,
    "--uid",
    "0",
    "--cpus",
    "2",
    "--memory",
    "2G",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CAP_CHOWN",
    "--cap-add",
    "CAP_NET_ADMIN",
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_READ_SEARCH",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--cap-add",
    "CAP_FOWNER",
    "--tmpfs",
    "/tmp",
    "--network",
    network,
    "--no-dns",
    "--entrypoint",
    "/bin/sh",
    DRYDOCK_INSIDE_IMAGE,
    "-lc",
    bootstrap,
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ponytail: host tar listing only, streamed line-by-line and bounded — never
// extracts on the host. Path entries (absolute/traversal/excluded) come from
// a `-tf` pass (paths only); forbidden entry types come from a `-tv` pass,
// read only by each line's leading ls(1)-style type char. Ceiling: a
// filename containing a literal newline could straddle two listing lines and
// dodge the traversal/absolute-path check; upgrade to a raw tar-header
// parser if that ever matters for a real workload.
async function validateArchive(path: string, timeoutMs: number): Promise<void> {
  await scanTarListing(["-tf", path], timeoutMs, checkArchivePathLine);
  await scanTarListing(["-tvf", path], timeoutMs, checkArchiveTypeLine);
}

function checkArchivePathLine(line: string): Error | undefined {
  const entryPath = line.replace(/\/$/, "");
  if (isAbsoluteArchivePath(entryPath)) {
    return new Error(`Drydock archive rejected: absolute path entry "${entryPath}"`);
  }
  if (hasArchivePathTraversal(entryPath)) {
    return new Error(`Drydock archive rejected: path traversal entry "${entryPath}"`);
  }
  if (isExcludedArchivePath(entryPath)) {
    return new Error(`Drydock archive rejected: excluded entry "${entryPath}"`);
  }
  return undefined;
}

function isAbsoluteArchivePath(entryPath: string): boolean {
  return entryPath.startsWith("/");
}

function hasArchivePathTraversal(entryPath: string): boolean {
  return entryPath.split("/").includes("..");
}

function isExcludedArchivePath(entryPath: string): boolean {
  const normalized = entryPath.startsWith("./") ? entryPath : `./${entryPath}`;
  return normalized === GUEST_AUTH_PATH;
}

function checkArchiveTypeLine(line: string): Error | undefined {
  const typeChar = line.charAt(0);
  if (FORBIDDEN_ARCHIVE_TYPE_CHARS.has(typeChar)) {
    return new Error(`Drydock archive rejected: forbidden entry type "${typeChar}" in "${line.trim()}"`);
  }
  return undefined;
}

// Tracks the archive line-count ceiling and per-line predicate check so the
// scanning callback below only has to decide whether to keep reading.
function createArchiveLineScanner(checkLine: (line: string) => Error | undefined): {
  check(line: string): Error | undefined;
  violation(): Error | undefined;
} {
  let violation: Error | undefined;
  let entryCount = 0;
  return {
    check(line: string): Error | undefined {
      if (violation) return violation;
      entryCount += 1;
      violation =
        entryCount > MAX_ARCHIVE_ENTRIES
          ? new Error(`Drydock archive rejected: exceeds ${MAX_ARCHIVE_ENTRIES} entries`)
          : checkLine(line);
      return violation;
    },
    violation: () => violation,
  };
}

async function scanTarListing(
  args: string[],
  timeoutMs: number,
  checkLine: (line: string) => Error | undefined,
): Promise<void> {
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrCollector = boundedTextCollector(child.stderr);
  const timeout = armKillTimeout(child, timeoutMs);
  const scanner = createArchiveLineScanner(checkLine);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", processArchiveLine.bind(undefined, scanner, child));
  try {
    const code = await waitForExit(child);
    throwArchiveViolation(scanner.violation());
    throwArchiveTimeout(timeout.timedOut(), timeoutMs);
    throwCorruptArchive(code, stderrCollector.text());
  } finally {
    timeout.clear();
  }
}

function throwArchiveViolation(violation: Error | undefined): void {
  if (violation) throw violation;
}

function throwArchiveTimeout(timedOut: boolean, timeoutMs: number): void {
  if (timedOut) throw new Error(`archive validation timed out after ${timeoutMs}ms`);
}

function throwCorruptArchive(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`Corrupt Drydock archive: ${stderr.trim() || `tar exited ${exitCode}`}`);
}

function processArchiveLine(
  scanner: ReturnType<typeof createArchiveLineScanner>,
  child: SpawnedChild,
  line: string,
): void {
  if (scanner.check(line)) child.kill("SIGKILL");
}

/** Collects stderr text up to a byte cap; keeps draining past the cap so the child never blocks on a full pipe. */
function boundedTextCollector(stream: NodeJS.ReadableStream, capBytes: number = STDERR_CAP_BYTES): { text(): string } {
  let text = "";
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    if (truncated) return;
    text += chunk.toString("utf8");
    if (text.length > capBytes) {
      text = `${text.slice(0, capBytes)}\n…(truncated)`;
      truncated = true;
    }
  });
  return { text: () => text };
}

interface ContainerSpawnResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

type SpawnedChild = ReturnType<typeof spawn>;

/** Arms a SIGKILL timeout on `child`; callers must call `clear()` once the child exits. */
function armKillTimeout(child: SpawnedChild, timeoutMs: number): { clear(): void; timedOut(): boolean } {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  return { clear: () => clearTimeout(timer), timedOut: () => timedOut };
}

/** Resolves with the child's exit code once it closes, or rejects on spawn error. */
function waitForExit(child: SpawnedChild): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function completeStreamedContainer(
  child: SpawnedChild,
  transfer: () => Promise<void>,
  operation: string,
  timeoutMs: number,
): Promise<string> {
  const stderrCollector = boundedTextCollector(child.stderr!);
  const timeout = armKillTimeout(child, timeoutMs);
  try {
    const [, exitCode] = await Promise.all([transfer(), waitForExit(child)]);
    if (exitCode !== 0) {
      throw new Error(`container ${operation} failed (exit ${exitCode}): ${stderrCollector.text().trim()}`);
    }
    return stderrCollector.text();
  } catch (error) {
    if (timeout.timedOut()) throw new Error(`container ${operation} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    timeout.clear();
  }
}

async function spawnContainer(
  executable: string,
  args: string[],
  input: Buffer | undefined,
  timeoutMs: number,
): Promise<ContainerSpawnResult> {
  const child = spawn(executable, args);
  const stdoutChunks: Buffer[] = [];
  const stderrCollector = boundedTextCollector(child.stderr);
  const timeout = armKillTimeout(child, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stdin.end(input);
  try {
    const exitCode = await waitForExit(child);
    if (timeout.timedOut()) throw new Error(`container ${args[0] ?? ""} timed out after ${timeoutMs}ms`);
    return { stdout: Buffer.concat(stdoutChunks), stderr: stderrCollector.text(), exitCode };
  } finally {
    timeout.clear();
  }
}

async function runContainer(
  executable: string,
  args: string[],
  input: Buffer | undefined,
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: string }> {
  const result = await spawnContainer(executable, args, input, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`container ${args[0] ?? ""} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

// True streaming: the child's stdout is piped directly (with backpressure)
// into an exclusively-created, owner-only temp file — the archive is never
// buffered whole in process memory. Stderr stays bounded for diagnostics.
async function runContainerExportToFile(
  executable: string,
  args: string[],
  destPath: string,
  timeoutMs: number,
): Promise<{ stderr: string }> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  const dest = createWriteStream(destPath, { flags: "wx", mode: 0o600 });
  const stderr = await completeStreamedContainer(child, () => pipeline(child.stdout!, dest), "export", timeoutMs);
  const handle = await open(destPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { stderr };
}

// True streaming: the archive is piped directly from disk (with
// backpressure) into the child's stdin — never read whole into memory.
// Restore output is discarded (drained, not buffered); stderr stays bounded.
async function runContainerRestoreFromFile(
  executable: string,
  args: string[],
  srcPath: string,
  timeoutMs: number,
): Promise<{ stderr: string }> {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume();
  const stderr = await completeStreamedContainer(
    child,
    () => pipeline(createReadStream(srcPath), child.stdin),
    "restore",
    timeoutMs,
  );
  return { stderr };
}

// Tolerates only a delete failure the CLI itself confirms is a missing
// resource (inspect also fails); a resource inspect still finds is a genuine
// failure and is surfaced, never swallowed.
async function deleteContainerResource(
  executable: string,
  deleteArgs: string[],
  inspectArgs: string[],
  timeoutMs: number,
  label: string,
): Promise<Error | undefined> {
  const result = await spawnContainer(executable, deleteArgs, undefined, timeoutMs);
  if (result.exitCode === 0) return undefined;
  const deleteError = new Error(`container ${label} delete failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  const inspect = await spawnContainer(executable, inspectArgs, undefined, timeoutMs);
  if (inspect.exitCode === 0) return deleteError;
  if (/not found|no such/i.test(inspect.stderr)) return undefined;
  return new AggregateError(
    [deleteError, new Error(`container ${label} inspect failed: ${inspect.stderr.trim()}`)],
    `Could not confirm ${label} deletion`,
  );
}

async function deleteComputeResources(
  executable: string,
  container: string,
  network: string,
  timeoutMs: number,
): Promise<void> {
  const errors: Error[] = [];
  const containerError = await deleteContainerResource(
    executable,
    ["delete", "--force", container],
    ["inspect", container],
    timeoutMs,
    "container",
  );
  if (containerError) errors.push(containerError);
  const networkError = await deleteContainerResource(
    executable,
    ["network", "delete", network],
    ["network", "inspect", network],
    timeoutMs,
    "network",
  );
  if (networkError) errors.push(networkError);
  throwCombined(errors, "Failed to delete Drydock compute resources");
}

/** Throws the sole error as-is, or an AggregateError when there's more than one; no-op when empty. */
function throwCombined(errors: Error[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
