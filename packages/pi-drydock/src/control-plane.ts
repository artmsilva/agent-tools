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
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
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
  /** Idle grace period before automatic hibernation. Set to 0 to disable. Default 5 minutes. */
  idleTimeoutMs?: number;
  onBackgroundError?: (error: Error, name: string) => void;
}

export interface DrydockLease {
  release(): void;
}

export interface DrydockExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DrydockReconcileResult {
  hibernated: string[];
  cleanedNetworks: string[];
  removedTemporarySnapshots: number;
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

interface ActivityState {
  leases: number;
  generation: number;
  transitioning: boolean;
  timer?: NodeJS.Timeout;
}

interface LeaseState {
  released: boolean;
}

interface TransitionState {
  state: ActivityState;
  wasActive: boolean;
}

export class DrydockControlPlane {
  readonly #stateRoot: string;
  readonly #executable: string;
  readonly #operationTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #onBackgroundError: (error: Error, name: string) => void;
  readonly #activity = new Map<string, ActivityState>();

  constructor(options: DrydockControlPlaneOptions = {}) {
    this.#stateRoot = resolveStateRoot(options.stateRoot);
    this.#executable = resolveContainerExecutable(options.containerExecutable);
    this.#operationTimeoutMs = resolveOperationTimeout(options.operationTimeoutMs);
    this.#idleTimeoutMs = resolveIdleTimeout(options.idleTimeoutMs);
    this.#onBackgroundError = resolveBackgroundErrorHandler(options.onBackgroundError);
  }

  async open(name: string): Promise<void> {
    const transition = this.#beginTransition(name, true);
    try {
      await this.#openNow(name);
      transition.state.transitioning = false;
      this.#scheduleIdle(name, transition.state);
    } catch (error) {
      this.#rollbackTransition(name, transition);
      throw error;
    }
  }

  async #openNow(name: string): Promise<void> {
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
    const release = this.#beginActivity(name);
    try {
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
    } finally {
      release();
    }
  }

  async hibernate(name: string): Promise<void> {
    await this.#runTransition(name, () => this.#hibernateNow(name));
  }

  async #hibernateNow(name: string): Promise<void> {
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

  acquireLease(name: string): DrydockLease {
    assertName(name);
    const release = this.#acquireActivity(name, true);
    if (!release) throw new Error(`Drydock is not active: ${name}`);
    return { release };
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
    await this.#runTransition(name, () => this.#destroyNow(name));
  }

  async #destroyNow(name: string): Promise<void> {
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

  async reconcile(): Promise<DrydockReconcileResult> {
    const result: DrydockReconcileResult = { hibernated: [], cleanedNetworks: [], removedTemporarySnapshots: 0 };
    const errors: Error[] = [];
    for (const name of await this.list()) {
      try {
        await this.#reconcileOne(name, result);
      } catch (error) {
        errors.push(new Error(`Failed to reconcile ${name}`, { cause: asError(error) }));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Drydock reconciliation failed");
    return result;
  }

  async #reconcileOne(name: string, result: DrydockReconcileResult): Promise<void> {
    const identity = await this.get(name);
    const { container, network } = containerResourceNames(identity.id);
    const containerExists = await resourceExists(
      this.#executable,
      ["inspect", container],
      this.#operationTimeoutMs,
      "container",
    );
    if (containerExists) {
      await this.#runTransition(name, () => this.#hibernateNow(name));
      result.hibernated.push(name);
    } else if (
      await resourceExists(
        this.#executable,
        ["network", "inspect", network],
        this.#operationTimeoutMs,
        "network",
      )
    ) {
      const error = await deleteContainerResource(
        this.#executable,
        ["network", "delete", network],
        ["network", "inspect", network],
        this.#operationTimeoutMs,
        "network",
      );
      if (error) throw error;
      result.cleanedNetworks.push(name);
    }
    result.removedTemporarySnapshots += await cleanupTemporarySnapshots(join(this.#stateRoot, name));
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

  async #runTransition(name: string, operation: () => Promise<void>): Promise<void> {
    const transition = this.#beginTransition(name, false);
    try {
      await operation();
      this.#activity.delete(name);
    } catch (error) {
      this.#rollbackTransition(name, transition);
      throw error;
    }
  }

  #beginTransition(name: string, requireInactive: boolean): TransitionState {
    assertName(name);
    const existing = this.#activity.get(name);
    assertTransitionAvailable(name, existing, requireInactive);
    const state = existing ?? { leases: 0, generation: 0, transitioning: false };
    if (existing) this.#cancelIdleTimer(name);
    state.transitioning = true;
    this.#activity.set(name, state);
    return { state, wasActive: existing !== undefined };
  }

  #rollbackTransition(name: string, transition: TransitionState): void {
    if (transition.wasActive) transition.state.transitioning = false;
    else this.#activity.delete(name);
  }

  #beginActivity(name: string): () => void {
    const release = this.#acquireActivity(name, false);
    if (!release) throw new Error(`Drydock is not active: ${name}`);
    return release;
  }

  #acquireActivity(name: string, strict: boolean): (() => void) | undefined {
    const state = this.#activity.get(name);
    if (!state) return undefined;
    if (state.transitioning) throw new Error(`Drydock lifecycle transition in progress: ${name}`);
    this.#cancelIdleTimer(name);
    state.leases += 1;
    const lease = { released: false };
    return () => this.#releaseActivity(name, state, lease, strict);
  }

  #releaseActivity(name: string, state: ActivityState, lease: LeaseState, strict: boolean): void {
    if (lease.released) return handleDuplicateRelease(strict, name);
    lease.released = true;
    if (this.#activity.get(name) !== state) return;
    state.leases -= 1;
    this.#scheduleIdle(name, state);
  }

  #cancelIdleTimer(name: string): void {
    const state = this.#activity.get(name);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.generation += 1;
  }

  #scheduleIdle(name: string, state: ActivityState): void {
    if (this.#idleTimeoutMs === 0 || state.leases > 0 || state.transitioning) return;
    this.#cancelIdleTimer(name);
    const generation = state.generation;
    state.timer = setTimeout(() => void this.#hibernateIfIdle(name, state, generation), this.#idleTimeoutMs);
    // Process exit intentionally wins; restart reconciliation owns orphaned compute.
    state.timer.unref();
  }

  async #hibernateIfIdle(name: string, state: ActivityState, generation: number): Promise<void> {
    if (!this.#isIdleGeneration(name, state, generation)) return;
    state.timer = undefined;
    state.transitioning = true;
    try {
      await this.#hibernateNow(name);
      this.#activity.delete(name);
    } catch (error) {
      state.transitioning = false;
      this.#onBackgroundError(asError(error), name);
    }
  }

  #isIdleGeneration(name: string, state: ActivityState, generation: number): boolean {
    return this.#activity.get(name) === state && state.generation === generation && state.leases === 0;
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

function assertTransitionAvailable(
  name: string,
  state: ActivityState | undefined,
  requireInactive: boolean,
): void {
  if (!state) return;
  assertNotTransitioning(name, state);
  assertInactiveRequirement(name, requireInactive);
  assertNoLeases(name, state);
}

function assertNotTransitioning(name: string, state: ActivityState): void {
  if (state.transitioning) throw new Error(`Drydock lifecycle transition in progress: ${name}`);
}

function assertInactiveRequirement(name: string, requireInactive: boolean): void {
  if (requireInactive) throw new Error(`Drydock is already active: ${name}`);
}

function assertNoLeases(name: string, state: ActivityState): void {
  if (state.leases > 0) throw new Error(`Drydock has ${state.leases} active lease(s): ${name}`);
}

function resolveStateRoot(value: string | undefined): string {
  return value ?? join(homedir(), "Library", "Application Support", "pi-drydock", "environments");
}

function resolveContainerExecutable(value: string | undefined): string {
  return value ?? "container";
}

function resolveOperationTimeout(value: number | undefined): number {
  return value ?? DEFAULT_OPERATION_TIMEOUT_MS;
}

function resolveIdleTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(timeout)) throw new Error(`Invalid idle timeout: ${timeout}`);
  if (timeout < 0) throw new Error(`Invalid idle timeout: ${timeout}`);
  return timeout;
}

function resolveBackgroundErrorHandler(
  value: ((error: Error, name: string) => void) | undefined,
): (error: Error, name: string) => void {
  return value ?? reportBackgroundError;
}

function reportBackgroundError(error: Error, name: string): void {
  console.error(`[pi-drydock] ${name} hibernation failed:`, error);
}

function handleDuplicateRelease(strict: boolean, name: string): void {
  if (strict) throw new Error(`Drydock lease already released: ${name}`);
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

async function resourceExists(
  executable: string,
  inspectArgs: string[],
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const result = await spawnContainer(executable, inspectArgs, undefined, timeoutMs);
  if (result.exitCode === 0) return true;
  if (/not found|no such/i.test(result.stderr)) return false;
  throw new Error(`container ${label} inspect failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

async function cleanupTemporarySnapshots(environmentDirectory: string): Promise<number> {
  const entries = await readdir(environmentDirectory);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(".rootfs-") || !entry.endsWith(".tar.tmp")) continue;
    await unlink(join(environmentDirectory, entry));
    removed += 1;
  }
  return removed;
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
