import type { Readable, Writable } from "node:stream";

export interface ConnectorPolicy {
  drydockId: string;
  provider: string;
  model: string;
  allowedModels?: ReadonlyArray<{ provider: string; model: string }>;
  upstreamOrigin: string;
  allowedPath: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrent: number;
  requestsPerMinute: number;
  timeoutMs: number;
  fixedHeaders?: Readonly<Record<string, string>>;
}

export interface ConnectorRequest {
  body: Buffer;
  signal: AbortSignal;
}

export interface ConnectorBrokerOptions {
  input: Readable;
  output: Writable;
  policy: ConnectorPolicy;
  resolveCredentialHeaders: () => Promise<Readonly<Record<string, string>>>;
  handleRequest?: (request: ConnectorRequest) => Promise<Response>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

type RequestFrame = {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body: string;
};

type BrokerFrame =
  | { type: "policy"; policy: ConnectorPolicy }
  | { type: "response-start"; id: string; status: number; headers: Record<string, string> }
  | { type: "response-chunk"; id: string; body: string }
  | { type: "response-end"; id: string }
  | { type: "response-error"; id: string; status: number; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_HEADER_ALLOWLIST = new Set(["content-type", "request-id", "x-request-id"]);
const SENSITIVE_FIXED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);
const FRAME_OVERHEAD_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;

export async function attachConnectorBroker(options: ConnectorBrokerOptions): Promise<void> {
  assertPolicy(options.policy);
  const writer = createFrameWriter(options.output);
  const state = { active: 0, requestTimes: [] as number[] };
  const pending = new Set<Promise<void>>();
  await writer.write({ type: "policy", policy: options.policy });
  try {
    for await (const value of readFrames(options.input, maxFrameBytes(options.policy))) {
      let frame: RequestFrame;
      try {
        frame = admitFrame(value, options, state);
      } catch (error) {
        await writer.write({
          type: "response-error",
          id: requestId(value),
          status: policyStatus(error),
          message: errorMessage(error),
        });
        continue;
      }
      state.active += 1;
      const task = forwardAndReport(frame, options, writer).finally(() => {
        state.active -= 1;
        pending.delete(task);
      });
      pending.add(task);
    }
  } finally {
    await Promise.allSettled(pending);
  }
}

function admitFrame(
  value: unknown,
  options: ConnectorBrokerOptions,
  state: { active: number; requestTimes: number[] },
): RequestFrame {
  const frame = parseRequestFrame(value);
  enforceAdmission(frame, options.policy, state, options.now?.() ?? Date.now());
  return frame;
}

async function forwardAndReport(
  frame: RequestFrame,
  options: ConnectorBrokerOptions,
  writer: ReturnType<typeof createFrameWriter>,
): Promise<void> {
  try {
    await forwardRequest(frame, options, writer);
  } catch (error) {
    const message = error instanceof ConnectorPolicyError ? error.message : "Connector upstream failed";
    await writer.write({ type: "response-error", id: frame.id, status: 502, message });
  }
}

function enforceAdmission(
  frame: RequestFrame,
  policy: ConnectorPolicy,
  state: { active: number; requestTimes: number[] },
  now: number,
): void {
  if (state.active >= policy.maxConcurrent) throw new ConnectorPolicyError(429, "Connector concurrency limit exceeded");
  state.requestTimes = state.requestTimes.filter((time) => time > now - RATE_WINDOW_MS);
  if (state.requestTimes.length >= policy.requestsPerMinute) throw new ConnectorPolicyError(429, "Connector rate limit exceeded");
  state.requestTimes.push(now);
  validateRequest(frame, policy);
}

function validateRequest(frame: RequestFrame, policy: ConnectorPolicy): void {
  assertAllowedMethod(frame.method);
  assertAllowedPath(frame.path, policy.allowedPath);
  assertAllowedModel(parseJsonBody(decodeBody(frame.body, policy.maxRequestBytes)), policy);
}

function assertAllowedMethod(method: string): void {
  if (method !== "POST") throw new ConnectorPolicyError(405, "Connector method denied");
}

function assertAllowedPath(path: string, allowedPath: string): void {
  if (path !== allowedPath) throw new ConnectorPolicyError(404, "Connector path denied");
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ConnectorPolicyError(400, "Connector requires a JSON request body");
  }
}

function assertAllowedModel(body: unknown, policy: ConnectorPolicy): void {
  if (!isRecord(body)) throw new ConnectorPolicyError(403, "Connector model denied");
  if (policy.allowedModels) return assertCatalogModel(body, policy.allowedModels);
  if (body.model !== policy.model) throw new ConnectorPolicyError(403, "Connector model denied");
}

function assertCatalogModel(
  body: Record<string, unknown>,
  allowedModels: ReadonlyArray<{ provider: string; model: string }>,
): void {
  for (const allowed of allowedModels) {
    if (body.provider === allowed.provider && body.model === allowed.model) return;
  }
  throw new ConnectorPolicyError(403, "Connector model denied");
}

async function forwardRequest(
  frame: RequestFrame,
  options: ConnectorBrokerOptions,
  writer: ReturnType<typeof createFrameWriter>,
): Promise<void> {
  const policy = options.policy;
  const body = decodeBody(frame.body, policy.maxRequestBytes);
  const signal = AbortSignal.timeout(policy.timeoutMs);
  const response = options.handleRequest
    ? await options.handleRequest({ body, signal })
    : await forwardHttpRequest(body, options, signal);
  await writer.write({
    type: "response-start",
    id: frame.id,
    status: response.status,
    headers: filterResponseHeaders(response.headers),
  });
  await streamResponse(frame.id, response, policy.maxResponseBytes, writer);
}

async function forwardHttpRequest(
  body: Buffer,
  options: ConnectorBrokerOptions,
  signal: AbortSignal,
): Promise<Response> {
  const credentialHeaders = await options.resolveCredentialHeaders();
  const headers = new Headers({
    "accept-encoding": "identity",
    "content-type": "application/json",
    ...options.policy.fixedHeaders,
    ...credentialHeaders,
  });
  return (options.fetch ?? globalThis.fetch)(new URL(options.policy.allowedPath, options.policy.upstreamOrigin), {
    method: "POST",
    headers,
    body: body.toString("utf8"),
    redirect: "error",
    signal,
  });
}

async function streamResponse(
  id: string,
  response: Response,
  maxBytes: number,
  writer: ReturnType<typeof createFrameWriter>,
): Promise<void> {
  if (response.body) await streamResponseBody(id, response.body, maxBytes, writer);
  await writer.write({ type: "response-end", id });
}

async function streamResponseBody(
  id: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  writer: ReturnType<typeof createFrameWriter>,
): Promise<void> {
  let total = 0;
  for await (const value of body) {
    total += value.byteLength;
    if (total > maxBytes) throw new ConnectorPolicyError(502, "Connector response limit exceeded");
    await writer.write({ type: "response-chunk", id, body: Buffer.from(value).toString("base64") });
  }
}

function parseRequestFrame(value: unknown): RequestFrame {
  assertRequestRecord(value);
  assertRequestId(value.id);
  assertRequestStrings(value);
  return value as RequestFrame;
}

function assertRequestRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorPolicyError(400, "Invalid connector frame");
  if (value.type !== "request") throw new ConnectorPolicyError(400, "Invalid connector frame");
}

function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new ConnectorPolicyError(400, "Invalid connector request ID");
  if (!UUID_PATTERN.test(value)) throw new ConnectorPolicyError(400, "Invalid connector request ID");
}

function assertRequestStrings(value: Record<string, unknown>): void {
  if (typeof value.method !== "string") throw new ConnectorPolicyError(400, "Invalid connector request");
  if (typeof value.path !== "string") throw new ConnectorPolicyError(400, "Invalid connector request");
  if (typeof value.body !== "string") throw new ConnectorPolicyError(400, "Invalid connector request");
}

function decodeBody(value: string, maxBytes: number): Buffer {
  const body = Buffer.from(value, "base64");
  if (body.byteLength > maxBytes) throw new ConnectorPolicyError(413, "Connector request limit exceeded");
  return body;
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) filtered[name.toLowerCase()] = value;
  }
  return filtered;
}

function assertPolicy(policy: ConnectorPolicy): void {
  assertDrydockScope(policy.drydockId);
  assertUpstreamOrigin(policy.upstreamOrigin);
  assertPathPolicy(policy.allowedPath);
  assertAllowedModels(policy.allowedModels);
  assertPublicFixedHeaders(policy.fixedHeaders);
  assertLimits([
    policy.maxRequestBytes,
    policy.maxResponseBytes,
    policy.maxConcurrent,
    policy.requestsPerMinute,
    policy.timeoutMs,
  ]);
}

function assertDrydockScope(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid Connector Drydock scope");
}

function assertUpstreamOrigin(value: string): void {
  const origin = new URL(value);
  if (origin.protocol !== "https:") throw new Error("Connector upstream must use HTTPS");
  if (origin.username || origin.password) throw new Error("Connector upstream cannot contain credentials");
}

function assertAllowedModels(models: ConnectorPolicy["allowedModels"]): void {
  if (!models) return;
  if (models.length === 0) throw new Error("Connector model catalog cannot be empty");
  for (const model of models) {
    assertPolicyIdentifier(model.provider);
    assertPolicyIdentifier(model.model);
  }
}

function assertPolicyIdentifier(value: string): void {
  if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error("Invalid Connector model catalog");
}

function assertPublicFixedHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) assertPublicFixedHeader(name);
}

function assertPublicFixedHeader(name: string): void {
  if (SENSITIVE_FIXED_HEADERS.has(name.toLowerCase())) throw new Error("Connector credentials require a resolver");
}

function assertPathPolicy(value: string): void {
  if (!value.startsWith("/")) throw new Error("Invalid Connector path policy");
  if (value.includes("?")) throw new Error("Invalid Connector path policy");
  if (value.includes("#")) throw new Error("Invalid Connector path policy");
}

function assertLimits(values: number[]): void {
  for (const value of values) assertPositiveInteger(value);
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid Connector limit policy");
  if (value <= 0) throw new Error("Invalid Connector limit policy");
}

function maxFrameBytes(policy: ConnectorPolicy): number {
  return Math.ceil((policy.maxRequestBytes * 4) / 3) + FRAME_OVERHEAD_BYTES;
}

async function* readFrames(input: Readable, maxBytes: number): AsyncGenerator<unknown> {
  const decoder = new FrameDecoder(maxBytes);
  for await (const chunk of input) {
    for (const frame of decoder.push(Buffer.from(chunk))) yield frame;
  }
  decoder.finish();
}

class FrameDecoder {
  readonly maxBytes: number;
  #pending = Buffer.alloc(0);

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): unknown[] {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    this.#assertBoundedPending();
    const frames: unknown[] = [];
    let newline = this.#pending.indexOf(0x0a);
    while (newline !== -1) {
      if (newline > 0) frames.push(this.#takeFrame(newline));
      else this.#pending = this.#pending.subarray(1);
      newline = this.#pending.indexOf(0x0a);
    }
    this.#assertBoundedPending();
    return frames;
  }

  finish(): void {
    if (this.#pending.byteLength > 0) throw new Error("Incomplete connector frame");
  }

  #assertBoundedPending(): void {
    if (this.#pending.byteLength <= this.maxBytes) return;
    if (!this.#pending.includes(0x0a)) throw new Error("Connector frame limit exceeded");
  }

  #takeFrame(newline: number): unknown {
    if (newline > this.maxBytes) throw new Error("Connector frame limit exceeded");
    const line = this.#pending.subarray(0, newline);
    this.#pending = this.#pending.subarray(newline + 1);
    return JSON.parse(line.toString("utf8"));
  }
}

function createFrameWriter(output: Writable): { write(frame: BrokerFrame): Promise<void> } {
  let chain = Promise.resolve();
  return {
    write(frame) {
      const data = `${JSON.stringify(frame)}\n`;
      chain = chain.then(() => writeWithBackpressure(output, data));
      return chain;
    },
  };
}

function writeWithBackpressure(output: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function requestId(value: unknown): string {
  return isRecord(value) && typeof value.id === "string" ? value.id : "00000000-0000-4000-8000-000000000000";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ConnectorPolicyError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function policyStatus(error: unknown): number {
  return error instanceof ConnectorPolicyError ? error.status : 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connector request failed";
}
