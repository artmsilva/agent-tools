import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOMBSTONE_PATTERN = /^\.destroy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION = 1;

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
}

export class DrydockControlPlane {
  readonly #stateRoot: string;

  constructor(options: DrydockControlPlaneOptions = {}) {
    this.#stateRoot =
      options.stateRoot ?? join(homedir(), "Library", "Application Support", "pi-drydock", "environments");
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
