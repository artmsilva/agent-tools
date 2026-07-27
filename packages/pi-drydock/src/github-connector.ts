import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectorRequest } from "./connector.ts";
import { createBoundedTextCollector } from "./bounded-text.ts";
import type { GitHubRepository } from "./workspace-handoff.ts";

export const GITHUB_PERMISSIONS = ["repo:read", "issues:comment:request"] as const;
export type GitHubPermission = typeof GITHUB_PERMISSIONS[number];
export type GitHubReviewStatus = "pending" | "executing" | "approved" | "rejected" | "failed";

export interface GuestGitHubPolicy {
  repository: GitHubRepository;
  permissions: readonly GitHubPermission[];
}

export interface GitHubReviewRequest {
  id: string;
  drydockId: string;
  repository: GitHubRepository;
  operation: "issue.comment";
  input: { number: number; body: string };
  createdAt: string;
  status: GitHubReviewStatus;
  resolvedAt?: string;
  result?: string;
}

export interface HostGitHubConnector {
  policy: GuestGitHubPolicy;
  handleRequest(request: ConnectorRequest): Promise<Response>;
}

export type GitHubRunner = (args: string[], signal?: AbortSignal) => Promise<string>;

interface GitHubConnectorOptions {
  drydockId: string;
  repository: GitHubRepository;
  permissions: readonly GitHubPermission[];
  requestsDirectory: string;
  executable?: string;
  runGh?: GitHubRunner;
  now?: () => Date;
}

interface ReviewStoreOptions {
  drydockId: string;
  repository: GitHubRepository;
  requestsDirectory: string;
  executable?: string;
  runGh?: GitHubRunner;
  now?: () => Date;
}

type GuestOperation =
  | { operation: "repo.view"; jsonFields?: string[] }
  | { operation: "issue.comment"; number: number; body: string };

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_FILE = /^([0-9a-f-]{36})\.(pending|executing|approved|rejected|failed)\.json$/i;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const JSON_FIELDS = new Set([
  "defaultBranchRef",
  "description",
  "homepageUrl",
  "isPrivate",
  "name",
  "nameWithOwner",
  "owner",
  "url",
  "viewerPermission",
]);
const MAX_COMMENT_BYTES = 64 * 1024;
const MAX_GH_OUTPUT_BYTES = 1024 * 1024;
const MAX_REVIEW_ERROR_BYTES = 4 * 1024;
const MAX_PENDING_REQUESTS = 100;
const GH_TIMEOUT_MS = 30_000;

export function createHostGitHubConnector(options: GitHubConnectorOptions): HostGitHubConnector {
  assertRepository(options.repository);
  const permissions = validatePermissions(options.permissions);
  const runGh = options.runGh ?? createGitHubRunner(options.executable);
  const policy = { repository: options.repository, permissions: [...permissions] };
  return {
    policy,
    handleRequest: (request) => handleGuestRequest(request, options, permissions, runGh),
  };
}

export async function listGitHubReviewRequests(options: ReviewStoreOptions): Promise<GitHubReviewRequest[]> {
  await prepareRequestsDirectory(options.requestsDirectory);
  const entries = await readdir(options.requestsDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && REVIEW_FILE.test(entry.name));
  const requests = await Promise.all(files.map((entry) => readReviewFile(options.requestsDirectory, entry.name)));
  for (const request of requests) assertReviewScope(request, options);
  return requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getGitHubReviewRequest(
  options: ReviewStoreOptions,
  id: string,
): Promise<GitHubReviewRequest> {
  assertReviewId(id);
  await prepareRequestsDirectory(options.requestsDirectory);
  for (const status of reviewStatuses()) {
    const name = reviewFileName(id, status);
    if (await regularFileExists(join(options.requestsDirectory, name))) {
      const request = await readReviewFile(options.requestsDirectory, name);
      assertReviewScope(request, options);
      return request;
    }
  }
  throw new Error(`Unknown Drydock GitHub review request: ${id}`);
}

export async function approveGitHubReviewRequest(
  options: ReviewStoreOptions,
  id: string,
): Promise<GitHubReviewRequest> {
  await assertPendingReviewScope(options, id);
  const executing = await claimReviewRequest(options.requestsDirectory, id);
  const runGh = options.runGh ?? createGitHubRunner(options.executable);
  try {
    const output = await executeReviewedOperation(executing, runGh);
    return resolveReviewRequest(options, executing, "approved", output.trim());
  } catch (error) {
    await resolveReviewRequest(options, executing, "failed", reviewFailure(error));
    throw error;
  }
}

export async function rejectGitHubReviewRequest(
  options: ReviewStoreOptions,
  id: string,
): Promise<GitHubReviewRequest> {
  await assertPendingReviewScope(options, id);
  const executing = await claimReviewRequest(options.requestsDirectory, id);
  return resolveReviewRequest(options, executing, "rejected");
}

async function handleGuestRequest(
  request: ConnectorRequest,
  options: GitHubConnectorOptions,
  permissions: ReadonlySet<GitHubPermission>,
  runGh: GitHubRunner,
): Promise<Response> {
  try {
    const operation = parseGuestOperation(request.body);
    if (operation.operation === "repo.view") {
      requirePermission(permissions, "repo:read");
      const output = await runGh(repoViewArgs(options.repository, operation.jsonFields), request.signal);
      return new Response(output, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    requirePermission(permissions, "issues:comment:request");
    const review = await queueReviewRequest(options, operation);
    return Response.json({ id: review.id, status: review.status, operation: review.operation });
  } catch (error) {
    return githubErrorResponse(error);
  }
}

function parseGuestOperation(body: Buffer): GuestOperation {
  const value = parseGuestJson(body);
  switch (value.operation) {
    case "repo.view": return parseRepoView(value);
    case "issue.comment": return parseIssueComment(value);
    default: throw new GitHubRequestError(403, "Drydock GitHub operation denied");
  }
}

function parseGuestJson(body: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (isRecord(value)) return value;
  } catch {}
  throw new GitHubRequestError(400, "Invalid Drydock GitHub request");
}

function parseRepoView(value: Record<string, unknown>): Extract<GuestOperation, { operation: "repo.view" }> {
  if (value.jsonFields === undefined) return { operation: "repo.view" };
  return { operation: "repo.view", jsonFields: parseJsonFields(value.jsonFields) };
}

function parseJsonFields(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GitHubRequestError(400, "Invalid gh JSON fields");
  if (value.length === 0) throw new GitHubRequestError(400, "Invalid gh JSON fields");
  for (const field of value) assertJsonField(field);
  return value as string[];
}

function assertJsonField(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new GitHubRequestError(403, "gh JSON field denied");
  if (!JSON_FIELDS.has(value)) throw new GitHubRequestError(403, "gh JSON field denied");
}

function parseIssueComment(
  value: Record<string, unknown>,
): Extract<GuestOperation, { operation: "issue.comment" }> {
  return { operation: "issue.comment", number: parseIssueNumber(value.number), body: parseCommentBody(value.body) };
}

function parseIssueNumber(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new GitHubRequestError(400, "Invalid GitHub issue number");
  if ((value as number) <= 0) throw new GitHubRequestError(400, "Invalid GitHub issue number");
  return value as number;
}

function parseCommentBody(value: unknown): string {
  if (typeof value !== "string") throw new GitHubRequestError(400, "Invalid GitHub comment body");
  assertCommentText(value);
  assertCommentSize(value);
  return value;
}

function assertCommentText(value: string): void {
  if (!value.trim()) throw new GitHubRequestError(400, "Invalid GitHub comment body");
  if (value.includes("\0")) throw new GitHubRequestError(400, "Invalid GitHub comment body");
}

function assertCommentSize(value: string): void {
  if (Buffer.byteLength(value) > MAX_COMMENT_BYTES) throw new GitHubRequestError(400, "Invalid GitHub comment body");
}

async function queueReviewRequest(
  options: GitHubConnectorOptions,
  operation: Extract<GuestOperation, { operation: "issue.comment" }>,
): Promise<GitHubReviewRequest> {
  await prepareRequestsDirectory(options.requestsDirectory);
  await assertPendingQueueCapacity(options.requestsDirectory);
  const request: GitHubReviewRequest = {
    id: randomUUID(),
    drydockId: options.drydockId,
    repository: options.repository,
    operation: operation.operation,
    input: { number: operation.number, body: operation.body },
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    status: "pending",
  };
  await writeNewReview(options.requestsDirectory, request);
  return request;
}

async function claimReviewRequest(
  directory: string,
  id: string,
): Promise<GitHubReviewRequest> {
  assertReviewId(id);
  await prepareRequestsDirectory(directory);
  const pendingPath = join(directory, reviewFileName(id, "pending"));
  const destination = join(directory, reviewFileName(id, "executing"));
  try {
    await rename(pendingPath, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Drydock GitHub review request is not pending: ${id}`);
    }
    throw error;
  }
  return readReviewFile(directory, reviewFileName(id, "executing"));
}

async function resolveReviewRequest(
  options: ReviewStoreOptions,
  request: GitHubReviewRequest,
  status: "approved" | "rejected" | "failed",
  result?: string,
): Promise<GitHubReviewRequest> {
  const resolved = {
    ...request,
    status,
    resolvedAt: (options.now?.() ?? new Date()).toISOString(),
    ...(result ? { result: result.slice(0, MAX_GH_OUTPUT_BYTES) } : {}),
  };
  const temporary = join(options.requestsDirectory, `.${request.id}.${status}.tmp`);
  await writeJsonFile(temporary, storedReview(resolved));
  await rename(temporary, join(options.requestsDirectory, reviewFileName(request.id, status)));
  await unlink(join(options.requestsDirectory, reviewFileName(request.id, request.status))).catch(ignoreMissing);
  return resolved;
}

function executeReviewedOperation(request: GitHubReviewRequest, runGh: GitHubRunner): Promise<string> {
  if (request.operation !== "issue.comment") throw new Error("Unsupported Drydock GitHub review operation");
  return runGh([
    "issue",
    "comment",
    String(request.input.number),
    "--repo",
    repositorySlug(request.repository),
    "--body",
    request.input.body,
  ]);
}

function repoViewArgs(repository: GitHubRepository, fields: string[] | undefined): string[] {
  const args = ["repo", "view", repositorySlug(repository)];
  if (fields) args.push("--json", fields.join(","));
  return args;
}

function createGitHubRunner(executable = "gh"): GitHubRunner {
  return (args, signal) => runGitHub(executable, args, signal);
}

function runGitHub(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    const stdout = createBoundedTextCollector(child.stdout, MAX_GH_OUTPUT_BYTES);
    const stderr = createBoundedTextCollector(child.stderr, MAX_GH_OUTPUT_BYTES);
    const timeout = setTimeout(() => child.kill("SIGKILL"), GH_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout());
      else reject(new Error(`Host gh failed (exit ${code ?? -1}): ${stderr().trim()}`));
    });
  });
}

async function prepareRequestsDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Invalid Drydock GitHub requests directory");
}

async function writeNewReview(directory: string, request: GitHubReviewRequest): Promise<void> {
  const temporary = join(directory, `.${request.id}.pending.tmp`);
  await writeJsonFile(temporary, storedReview(request));
  try {
    await rename(temporary, join(directory, reviewFileName(request.id, "pending")));
  } catch (error) {
    await unlink(temporary).catch(ignoreMissing);
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readReviewFile(directory: string, name: string): Promise<GitHubReviewRequest> {
  const { id, status } = parseReviewFileName(name);
  const path = join(directory, name);
  assertReviewFile(await lstat(path));
  const value = parseStoredReview(await readFile(path, "utf8"));
  if (value.id !== id) throw new Error("Invalid Drydock GitHub review request ID");
  return { ...value, status };
}

function parseReviewFileName(name: string): { id: string; status: GitHubReviewStatus } {
  const match = REVIEW_FILE.exec(name);
  if (!match) throw new Error("Invalid Drydock GitHub review request file");
  return { id: match[1], status: match[2] as GitHubReviewStatus };
}

function assertReviewFile(state: Awaited<ReturnType<typeof lstat>>): void {
  if (!state.isFile()) throw new Error("Invalid Drydock GitHub review request file");
  if (state.isSymbolicLink()) throw new Error("Invalid Drydock GitHub review request file");
}

function parseStoredReview(text: string): GitHubReviewRequest {
  const value = parseStoredReviewJson(text);
  const operation = readStoredOperation(value);
  const request: GitHubReviewRequest = {
    id: readReviewId(value.id),
    drydockId: readDrydockId(value.drydockId),
    repository: parseRepository(value.repository),
    operation: "issue.comment",
    input: { number: operation.number, body: operation.body },
    createdAt: readReviewDate(value.createdAt),
    status: "pending",
  };
  const resolvedAt = readOptionalReviewDate(value.resolvedAt);
  const result = readOptionalReviewResult(value.result);
  if (resolvedAt) request.resolvedAt = resolvedAt;
  if (result) request.result = result;
  return request;
}

function parseStoredReviewJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && value.schemaVersion === REVIEW_SCHEMA_VERSION) return value;
  } catch {}
  throw new Error("Invalid Drydock GitHub review request");
}

function readStoredOperation(value: Record<string, unknown>): Extract<GuestOperation, { operation: "issue.comment" }> {
  if (value.operation !== "issue.comment") throw new Error("Invalid Drydock GitHub review request");
  if (!isRecord(value.input)) throw new Error("Invalid Drydock GitHub review request");
  return parseIssueComment({ operation: value.operation, ...value.input });
}

function readReviewId(value: unknown): string {
  assertReviewId(value);
  return value;
}

function readDrydockId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Drydock GitHub review request");
  if (!REVIEW_ID.test(value)) throw new Error("Invalid Drydock GitHub review request");
  return value;
}

function readReviewDate(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Drydock GitHub review request");
  if (Number.isNaN(Date.parse(value))) throw new Error("Invalid Drydock GitHub review request");
  return value;
}

function readOptionalReviewDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return readReviewDate(value);
}

function readOptionalReviewResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid Drydock GitHub review request");
  return value;
}

function storedReview(request: GitHubReviewRequest): Record<string, unknown> {
  const { status: _status, ...value } = request;
  return { schemaVersion: REVIEW_SCHEMA_VERSION, ...value };
}

function parseRepository(value: unknown): GitHubRepository {
  if (!isRecord(value)) throw new Error("Invalid Drydock GitHub repository");
  if (value.host !== "github.com") throw new Error("Invalid Drydock GitHub repository");
  const repository = {
    host: "github.com" as const,
    owner: readRepositoryPart(value.owner),
    name: readRepositoryPart(value.name),
  };
  assertRepository(repository);
  return repository;
}

function readRepositoryPart(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Drydock GitHub repository");
  return value;
}

function validatePermissions(values: readonly GitHubPermission[]): ReadonlySet<GitHubPermission> {
  const permissions = new Set<GitHubPermission>();
  for (const value of values) {
    if (!GITHUB_PERMISSIONS.includes(value)) throw new Error(`Unsupported Drydock GitHub permission: ${value}`);
    permissions.add(value);
  }
  if (permissions.size === 0) throw new Error("Drydock GitHub permissions cannot be empty");
  return permissions;
}

function requirePermission(permissions: ReadonlySet<GitHubPermission>, permission: GitHubPermission): void {
  if (!permissions.has(permission)) throw new GitHubRequestError(403, `Drydock GitHub permission denied: ${permission}`);
}

function assertRepository(repository: GitHubRepository): void {
  if (repository.host !== "github.com") throw new Error("Unsupported Drydock GitHub host");
  if (!REPOSITORY_PART.test(repository.owner) || !REPOSITORY_PART.test(repository.name)) {
    throw new Error("Invalid Drydock GitHub repository");
  }
}

function repositorySlug(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function assertReviewScope(request: GitHubReviewRequest, options: ReviewStoreOptions): void {
  if (request.drydockId !== options.drydockId) throw new Error("Drydock GitHub review request scope mismatch");
  if (repositorySlug(request.repository) !== repositorySlug(options.repository)) {
    throw new Error("Drydock GitHub review request repository mismatch");
  }
}

function assertReviewId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REVIEW_ID.test(value)) throw new Error("Invalid Drydock GitHub review request ID");
}

function reviewStatuses(): GitHubReviewStatus[] {
  return ["pending", "executing", "approved", "rejected", "failed"];
}

function reviewFileName(id: string, status: GitHubReviewStatus): string {
  return `${id}.${status}.json`;
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const state = await lstat(path);
    return state.isFile() && !state.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function githubErrorResponse(error: unknown): Response {
  if (error instanceof GitHubRequestError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: "Drydock GitHub host operation failed" }, { status: 502 });
}

async function assertPendingReviewScope(options: ReviewStoreOptions, id: string): Promise<void> {
  assertReviewId(id);
  const name = reviewFileName(id, "pending");
  if (!await regularFileExists(join(options.requestsDirectory, name))) {
    throw new Error(`Drydock GitHub review request is not pending: ${id}`);
  }
  assertReviewScope(await readReviewFile(options.requestsDirectory, name), options);
}

async function assertPendingQueueCapacity(directory: string): Promise<void> {
  const entries = await readdir(directory);
  const pending = entries.filter((name) => name.endsWith(".pending.json"));
  if (pending.length >= MAX_PENDING_REQUESTS) throw new GitHubRequestError(429, "Drydock GitHub review queue is full");
}

function reviewFailure(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, MAX_REVIEW_ERROR_BYTES) : "Host gh failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

class GitHubRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
