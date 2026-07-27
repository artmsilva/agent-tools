import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createBoundedTextCollector } from "./bounded-text.ts";

const SOURCE_LIST_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const TRACKED_FILE_LIMIT = 200_000;
const SUPPORTED_MODES = new Set(["100644", "100755"]);

export interface DrydockWorkspaceBinding {
  sourceRoot: string;
  sourceHead: string;
  sourceDigest: string;
  trackedFiles: number;
  importedAt: string;
}

export interface PreparedWorkspaceArchive {
  binding: DrydockWorkspaceBinding;
  path: string;
}

export interface DrydockHandoff {
  id: string;
  sourceRoot: string;
  sourceHead: string;
  sourceDigest: string;
  patchDigest: string;
  patchPath: string;
  sizeBytes: number;
  createdAt: string;
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export async function prepareWorkspaceArchive(
  sourceRoot: string,
  environmentDirectory: string,
  timeoutMs: number,
): Promise<PreparedWorkspaceArchive> {
  const canonicalRoot = await canonicalRepositoryRoot(sourceRoot, timeoutMs);
  const sourceHead = (await runGit(canonicalRoot, ["rev-parse", "HEAD"], timeoutMs)).stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceHead)) throw new Error("Invalid Drydock workspace HEAD");
  const entries = parseTrackedEntries((await runGit(canonicalRoot, ["ls-files", "--stage", "-z"], timeoutMs)).stdout);
  await validateTrackedEntries(canonicalRoot, entries);
  const path = join(environmentDirectory, `.workspace-${randomUUID()}.tar.tmp`);
  try {
    const trackedPaths = entries.map(({ path }) => path);
    await writeTrackedArchive(canonicalRoot, trackedPaths, path, timeoutMs);
    await validateTrackedArchive(path, trackedPaths, timeoutMs);
    return {
      path,
      binding: {
        sourceRoot: canonicalRoot,
        sourceHead,
        sourceDigest: await sha256File(path),
        trackedFiles: entries.length,
        importedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    await unlink(path).catch(ignoreMissing);
    throw error;
  }
}

export async function verifyWorkspaceSource(
  binding: DrydockWorkspaceBinding,
  environmentDirectory: string,
  timeoutMs: number,
): Promise<void> {
  const prepared = await prepareWorkspaceArchive(binding.sourceRoot, environmentDirectory, timeoutMs);
  try {
    if (
      prepared.binding.sourceHead !== binding.sourceHead ||
      prepared.binding.sourceDigest !== binding.sourceDigest ||
      prepared.binding.trackedFiles !== binding.trackedFiles
    ) {
      throw new Error("Drydock workspace source changed since import");
    }
  } finally {
    await unlink(prepared.path).catch(ignoreMissing);
  }
}

export async function verifyPatchApplies(sourceRoot: string, patchPath: string, timeoutMs: number): Promise<void> {
  if ((await stat(patchPath)).size === 0) return;
  await runGit(sourceRoot, ["apply", "--check", "--binary", patchPath], timeoutMs);
}

async function canonicalRepositoryRoot(sourceRoot: string, timeoutMs: number): Promise<string> {
  const requested = resolve(sourceRoot);
  const canonical = await realpath(requested);
  if (requested !== canonical) throw new Error("Drydock workspace root cannot contain symlinks");
  const topLevel = (await runGit(canonical, ["rev-parse", "--show-toplevel"], timeoutMs)).stdout.toString("utf8").trim();
  if ((await realpath(topLevel)) !== canonical) throw new Error("Drydock workspace must be a Git repository root");
  return canonical;
}

interface TrackedEntry {
  mode: string;
  path: string;
}

function parseTrackedEntries(output: Buffer): TrackedEntry[] {
  if (output.byteLength > SOURCE_LIST_LIMIT) throw new Error("Drydock tracked-file list is too large");
  const records = output.toString("utf8").split("\0").filter(Boolean);
  if (records.length > TRACKED_FILE_LIMIT) throw new Error("Drydock has too many tracked files");
  return records.map((record) => {
    const match = /^(\d{6}) [0-9a-f]{40,64} (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== "0") throw new Error("Invalid Drydock tracked-file entry");
    return { mode: match[1], path: match[3] };
  });
}

async function validateTrackedEntries(root: string, entries: TrackedEntry[]): Promise<void> {
  for (const entry of entries) await validateTrackedEntry(root, entry);
}

async function validateTrackedEntry(root: string, entry: TrackedEntry): Promise<void> {
  assertSupportedEntry(entry);
  const path = join(root, entry.path);
  const state = await lstat(path);
  if (!state.isFile()) throw unsupportedEntry(entry.path);
  if (state.isSymbolicLink()) throw unsupportedEntry(entry.path);
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${root}${sep}`)) throw new Error(`Drydock tracked path escapes source root: ${entry.path}`);
}

function assertSupportedEntry(entry: TrackedEntry): void {
  if (!SUPPORTED_MODES.has(entry.mode)) throw unsupportedEntry(entry.path);
  if (!isSafeRelativePath(entry.path)) throw unsupportedEntry(entry.path);
}

function unsupportedEntry(path: string): Error {
  return new Error(`Drydock has unsupported tracked entry: ${path}`);
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

async function validateTrackedArchive(archive: string, expectedPaths: string[], timeoutMs: number): Promise<void> {
  const listed = await runBounded("tar", ["-tf", archive], undefined, timeoutMs, "archive listing");
  const paths = listed.stdout.toString("utf8").split("\n").filter(Boolean);
  assertArchivePaths(paths, expectedPaths);
  const verbose = await runBounded("tar", ["-tvf", archive], undefined, timeoutMs, "archive type listing");
  const entries = verbose.stdout.toString("utf8").split("\n").filter(Boolean);
  assertArchiveTypes(entries, expectedPaths.length);
}

function assertArchivePaths(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length) throw new Error("Invalid Drydock workspace archive entries");
  const mismatch = actual.findIndex((path, index) => path !== expected[index]);
  if (mismatch !== -1) throw new Error("Invalid Drydock workspace archive path");
}

function assertArchiveTypes(entries: string[], expectedCount: number): void {
  if (entries.length !== expectedCount) throw new Error("Invalid Drydock workspace archive entries");
  if (entries.some((entry) => entry[0] !== "-")) throw new Error("Invalid Drydock workspace archive type");
}

async function writeTrackedArchive(root: string, paths: string[], destination: string, timeoutMs: number): Promise<void> {
  const file = await open(destination, "wx", 0o600);
  await file.close();
  const metadataArgs = process.platform === "darwin" ? ["--no-xattrs", "--no-acls", "--no-fflags"] : [];
  const child = spawn(
    "tar",
    ["-C", root, "--no-recursion", ...metadataArgs, "--null", "-T", "-", "-cf", "-"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr = createBoundedTextCollector(child.stderr, STDERR_LIMIT);
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdin.on("error", () => undefined);
  try {
    child.stdin.end(Buffer.from(`${paths.join("\0")}${paths.length ? "\0" : ""}`));
    const [, exitCode] = await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { flags: "r+", start: 0 })),
      waitForExit(child),
    ]);
    if (exitCode !== 0) throw new Error(`Drydock workspace archive failed (exit ${exitCode}): ${stderr().trim()}`);
    const handle = await open(destination, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    clearTimeout(timeout);
  }
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return runBounded("git", args, cwd, timeoutMs, "Git command");
}

async function runBounded(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  label: string,
): Promise<GitResult> {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr = createBoundedTextCollector(child.stderr, STDERR_LIMIT);
  let bytes = 0;
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > SOURCE_LIST_LIMIT) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  try {
    const exitCode = await waitForExit(child);
    if (bytes > SOURCE_LIST_LIMIT) throw new Error(`Drydock ${label} output is too large`);
    if (exitCode !== 0) throw new Error(`Drydock ${label} failed (exit ${exitCode}): ${stderr().trim()}`);
    return { stdout: Buffer.concat(stdout), stderr: stderr(), exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
