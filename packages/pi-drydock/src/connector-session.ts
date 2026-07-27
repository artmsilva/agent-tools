import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attachConnectorBroker, type ConnectorBrokerOptions, type ConnectorPolicy } from "./connector.ts";

const DEFAULT_CAPABILITY_TTL_MS = 15 * 60_000;
const PROCESS_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 2_000;
const STDERR_LIMIT = 64 * 1024;
const SHIM_DESTINATION = "/run/pi-drydock/connector-shim.mjs";
const PROVIDER_DESTINATION = "/run/pi-drydock/pi-provider.ts";

export interface ConnectorSessionOptions {
  containerExecutable: string;
  container: string;
  policy: ConnectorPolicy;
  resolveCredentialHeaders: ConnectorBrokerOptions["resolveCredentialHeaders"];
  releaseLease: () => void;
  capabilityTtlMs?: number;
  onBackgroundError?: (error: Error) => void;
}

export interface ConnectorSession {
  readonly expiresAt: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function openAppleConnectorSession(options: ConnectorSessionOptions): Promise<ConnectorSession> {
  const ttlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  assertTtl(ttlMs);
  await installGuestFile(options, "connector-shim.mjs", SHIM_DESTINATION);
  await installGuestFile(options, "pi-provider.ts", PROVIDER_DESTINATION);
  const channel = spawn(options.containerExecutable, connectorChannelArgs(options.container));
  const stderr = collectBounded(channel.stderr);
  const broker = attachConnectorBroker({
    input: channel.stdout,
    output: channel.stdin,
    policy: options.policy,
    resolveCredentialHeaders: options.resolveCredentialHeaders,
  });
  const session = manageConnectorSession({
    channel,
    broker,
    releaseLease: options.releaseLease,
    capabilityTtlMs: ttlMs,
    onBackgroundError: options.onBackgroundError,
    stderr,
  });
  try {
    await waitUntilReady(options);
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

interface ManagedSessionOptions {
  channel: ChildProcessWithoutNullStreams;
  broker: Promise<void>;
  releaseLease: () => void;
  capabilityTtlMs: number;
  onBackgroundError?: (error: Error) => void;
  stderr?: () => string;
}

export function manageConnectorSession(options: ManagedSessionOptions): ConnectorSession {
  assertTtl(options.capabilityTtlMs);
  const onBackgroundError = options.onBackgroundError ?? defaultBackgroundError;
  const expiresAt = new Date(Date.now() + options.capabilityTtlMs).toISOString();
  let closeStarted = false;
  let released = false;
  let killTimer: NodeJS.Timeout | undefined;
  const broker = options.broker.catch((error) => {
    options.channel.kill("SIGKILL");
    throw error;
  });
  const closed = Promise.all([broker, waitForChannel(options.channel, options.stderr)]).then(() => undefined).finally(() => {
    if (killTimer) clearTimeout(killTimer);
    clearTimeout(expiryTimer);
    if (!released) {
      released = true;
      options.releaseLease();
    }
  });
  closed.catch(onBackgroundError);
  const close = (): Promise<void> => {
    if (!closeStarted) {
      closeStarted = true;
      options.channel.stdin.end();
      killTimer = setTimeout(() => options.channel.kill("SIGKILL"), CLOSE_GRACE_MS);
      killTimer.unref();
    }
    return closed;
  };
  const expiryTimer = setTimeout(() => void close().catch(onBackgroundError), options.capabilityTtlMs);
  expiryTimer.unref();
  return { expiresAt, closed, close };
}

async function installGuestFile(options: ConnectorSessionOptions, sourceName: string, destination: string): Promise<void> {
  const source = join(import.meta.dirname, "..", "guest", sourceName);
  await runProcess(
    options.containerExecutable,
    [
      "exec",
      "--interactive",
      "--uid",
      "0",
      "--gid",
      "0",
      options.container,
      "/bin/sh",
      "-c",
      `umask 022; mkdir -p /run/pi-drydock; chmod 0755 /run/pi-drydock; cat > ${destination}; chmod 0555 ${destination}`,
    ],
    await readFile(source),
  );
}

function connectorChannelArgs(container: string): string[] {
  return [
    "exec",
    "--interactive",
    "--uid",
    "1000",
    "--gid",
    "1000",
    container,
    "/bin/sh",
    "-c",
    `DRYDOCK_CONNECTOR_PORT=43127 exec node ${SHIM_DESTINATION}`,
  ];
}

async function waitUntilReady(options: ConnectorSessionOptions): Promise<void> {
  const probe =
    'for(let i=0;i<50;i++){try{const r=await fetch("http://127.0.0.1:43127/.well-known/pi-drydock-connector");if(r.ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)';
  await runProcess(
    options.containerExecutable,
    ["exec", "--uid", "1000", "--gid", "1000", options.container, "node", "-e", probe],
  );
}

function runProcess(executable: string, args: string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args);
    const stderr = collectBounded(child.stderr);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROCESS_TIMEOUT_MS);
    child.stdout.resume();
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`Connector setup timed out after ${PROCESS_TIMEOUT_MS}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`Connector setup failed (exit ${code ?? -1}): ${stderr().trim()}`));
    });
  });
}

function waitForChannel(channel: ChildProcessWithoutNullStreams, stderr: (() => string) | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.once("error", reject);
    channel.once("close", (code, signal) => finishChannel(resolve, reject, code, signal, stderr));
  });
}

function finishChannel(
  resolve: () => void,
  reject: (error: Error) => void,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: (() => string) | undefined,
): void {
  if (code === 0) return resolve();
  reject(new Error(`Connector channel failed (${channelFailureReason(code, signal)}): ${channelStderr(stderr)}`));
}

function channelFailureReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? -1}`;
}

function channelStderr(stderr: (() => string) | undefined): string {
  return stderr ? stderr().trim() : "";
}

function collectBounded(stream: NodeJS.ReadableStream): () => string {
  const chunks: Buffer[] = [];
  let total = 0;
  stream.on("data", (chunk: Buffer) => {
    if (total >= STDERR_LIMIT) return;
    const kept = chunk.subarray(0, STDERR_LIMIT - total);
    chunks.push(kept);
    total += kept.byteLength;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Connector capability TTL: ${value}`);
}

function defaultBackgroundError(error: Error): void {
  console.error("[pi-drydock] Connector session failed:", error);
}
