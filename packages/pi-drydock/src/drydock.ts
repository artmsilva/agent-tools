import { spawn } from "node:child_process";

export const DRYDOCK_IMAGE =
  "docker.io/library/alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40";

const MAX_SECTION_CHARS = 20_000;
const GUEST_UID = "65534";
const GUEST_GID = "65534";

export interface DrydockResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  patch: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DrydockOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function buildCreateArgs(name: string, network: string): string[] {
  const bootstrap = [
    "gateway=$(ip route | awk '/^default/ {print $3; exit}')",
    "printf '%s' \"$gateway\" > /tmp/host-gateway",
    "ip link set eth0 down",
    "exec su nobody -s /bin/sh -c 'exec sleep 600'",
  ].join("; ");

  return [
    "create",
    "--name",
    name,
    "--cpus",
    "1",
    "--memory",
    "512M",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CAP_NET_ADMIN",
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/baseline",
    "--tmpfs",
    "/workspace",
    "--network",
    network,
    "--no-dns",
    DRYDOCK_IMAGE,
    "/bin/sh",
    "-lc",
    bootstrap,
  ];
}

export function buildGuestShellArgs(command: string): string[] {
  return [
    "/bin/setpriv",
    "--nnp",
    "--inh-caps",
    "",
    "--ambient-caps",
    "",
    "/bin/sh",
    "-lc",
    command,
  ];
}

export function buildTarArgs(cwd: string): string[] {
  return ["-C", cwd, "--null", "-T", "-", "-cf", "-"];
}

function truncate(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) return text;
  return `${text.slice(0, MAX_SECTION_CHARS)}\n… [truncated ${text.length - MAX_SECTION_CHARS} chars]`;
}

export function renderDrydockResult(result: DrydockResult): string {
  const sections = [
    `exit_code: ${result.exitCode}`,
    result.stdout ? `stdout:\n${truncate(result.stdout.trimEnd())}` : "stdout: (empty)",
    result.stderr ? `stderr:\n${truncate(result.stderr.trimEnd())}` : "stderr: (empty)",
    result.patch ? `patch (not applied):\n${truncate(result.patch.trimEnd())}` : "patch: (no text changes)",
  ];
  return sections.join("\n\n");
}

function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("aborted")));
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error(`timeout:${options.timeoutMs}`)));
        }, options.timeoutMs)
      : undefined;

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
  });
}

async function runChecked(
  command: string,
  args: string[],
  options: RunProcessOptions,
  label: string,
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed (${result.code})\n${result.stderr || result.stdout}`);
  }
  return result;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

interface WorkspacePipeline {
  tar: ReturnType<typeof spawn>;
  guest: ReturnType<typeof spawn>;
  errors: { tar: string; guest: string };
}

function startWorkspacePipeline(cwd: string, name: string, trackedFiles: string): WorkspacePipeline {
  const tar = spawn("tar", buildTarArgs(cwd), { stdio: ["pipe", "pipe", "pipe"] });
  const guest = spawn(
    "container",
    [
      "exec",
      "--interactive",
      "--uid",
      GUEST_UID,
      "--gid",
      GUEST_GID,
      name,
      ...buildGuestShellArgs("tar -xf - -C /baseline && cp -a /baseline/. /workspace/"),
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const errors = { tar: "", guest: "" };
  tar.stderr.on("data", (chunk: Buffer) => (errors.tar += chunk.toString()));
  guest.stderr.on("data", (chunk: Buffer) => (errors.guest += chunk.toString()));
  guest.stdin.on("error", () => {});
  tar.stdin.on("error", () => {});
  tar.stdin.end(trackedFiles);
  tar.stdout.pipe(guest.stdin);
  return { tar, guest, errors };
}

function stopWorkspacePipeline(pipeline: WorkspacePipeline): void {
  pipeline.tar.kill("SIGKILL");
  pipeline.guest.kill("SIGKILL");
}

function workspacePipelineError(pipeline: WorkspacePipeline, tarCode: number, guestCode: number): Error | undefined {
  if (tarCode === 0 && guestCode === 0) return undefined;
  return new Error(
    `workspace stream failed (tar=${tarCode}, guest=${guestCode})\n${pipeline.errors.tar}${pipeline.errors.guest}`,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}

function assertWorkspaceCompletion(
  pipeline: WorkspacePipeline,
  codes: number[],
  timedOut: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  if (timedOut) throw new Error(`timeout:${timeoutMs}`);
  const failure = workspacePipelineError(pipeline, codes[0], codes[1]);
  if (failure) throw failure;
}

async function streamWorkspace(
  cwd: string,
  name: string,
  trackedFiles: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const pipeline = startWorkspacePipeline(cwd, name, trackedFiles);
  const stop = () => stopWorkspacePipeline(pipeline);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const codes = await Promise.all([waitForExit(pipeline.tar), waitForExit(pipeline.guest)]);
    assertWorkspaceCompletion(pipeline, codes, timedOut, timeoutMs, signal);
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

type RemainingTime = () => number;

interface DrydockResources {
  container: boolean;
  network: boolean;
}

function buildGuestExecArgs(name: string, command: string, workdir?: string): string[] {
  return [
    "exec",
    "--uid",
    GUEST_UID,
    "--gid",
    GUEST_GID,
    ...(workdir ? ["--workdir", workdir] : []),
    name,
    ...buildGuestShellArgs(command),
  ];
}

async function prepareDrydock(
  options: DrydockOptions,
  name: string,
  network: string,
  remaining: RemainingTime,
  resources: DrydockResources,
): Promise<void> {
  const processOptions = () => ({ timeoutMs: remaining(), signal: options.signal });
  const tracked = await runChecked(
    "git",
    ["ls-files", "-z", "--cached"],
    { ...processOptions(), cwd: options.cwd },
    "tracked-file discovery",
  );
  await runChecked("container", ["network", "create", "--internal", network], processOptions(), "network creation");
  resources.network = true;
  await runChecked("container", buildCreateArgs(name, network), processOptions(), "container creation");
  resources.container = true;
  await runChecked("container", ["start", name], processOptions(), "container start");
  const boundaryCommand =
    'test "$(cat /sys/class/net/eth0/operstate)" = down && grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status && ! ip link set eth0 up 2>/dev/null';
  await runChecked(
    "container",
    buildGuestExecArgs(name, boundaryCommand),
    processOptions(),
    "network boundary check",
  );
  await streamWorkspace(options.cwd, name, tracked.stdout, remaining(), options.signal);
}

async function executeDrydockCommand(
  options: DrydockOptions,
  name: string,
  remaining: RemainingTime,
): Promise<DrydockResult> {
  const command = await runProcess("container", buildGuestExecArgs(name, options.command, "/workspace"), {
    timeoutMs: remaining(),
    signal: options.signal,
  });
  const patchCommand =
    "diff -ruN /baseline /workspace > /tmp/raw.patch; code=$?; [ $code -le 1 ] || exit $code; sed -e 's#^--- /baseline/#--- a/#' -e 's#^+++ /workspace/#+++ b/#' /tmp/raw.patch";
  const patch = await runChecked(
    "container",
    buildGuestExecArgs(name, patchCommand),
    { timeoutMs: remaining(), signal: options.signal },
    "patch export",
  );
  return { stdout: command.stdout, stderr: command.stderr, exitCode: command.code, patch: patch.stdout };
}

async function cleanupDrydock(
  name: string,
  network: string,
  resources: DrydockResources,
): Promise<string[]> {
  const errors: string[] = [];
  const deadline = Date.now() + 10_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (resources.container) {
    await runChecked("container", ["delete", "--force", name], { timeoutMs: remaining() }, "container cleanup").catch(
      (error: unknown) => errors.push(String(error)),
    );
  }
  if (resources.network) {
    await runChecked("container", ["network", "delete", network], { timeoutMs: remaining() }, "network cleanup").catch(
      (error: unknown) => errors.push(String(error)),
    );
  }
  return errors;
}

function throwCleanupFailure(cleanupErrors: string[], failure: unknown): void {
  if (cleanupErrors.length === 0) return;
  const cleanupFailure = new Error(cleanupErrors.join("\n"));
  if (failure) throw new AggregateError([failure, cleanupFailure], "Drydock failed and cleanup was incomplete");
  throw cleanupFailure;
}

function resolveDrydockResult(
  result: DrydockResult | undefined,
  failure: unknown,
  cleanupErrors: string[],
): DrydockResult {
  throwCleanupFailure(cleanupErrors, failure);
  if (failure) throw failure;
  if (!result) throw new Error("Drydock produced no result");
  return result;
}

export async function runDrydock(options: DrydockOptions): Promise<DrydockResult> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `pi-drydock-${suffix}`;
  const network = `pi-drydock-net-${suffix}`;
  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error(`timeout:${options.timeoutMs}`);
    return milliseconds;
  };
  const resources = { container: false, network: false };
  let result: DrydockResult | undefined;
  let failure: unknown;
  try {
    await prepareDrydock(options, name, network, remaining, resources);
    result = await executeDrydockCommand(options, name, remaining);
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = await cleanupDrydock(name, network, resources);
  return resolveDrydockResult(result, failure, cleanupErrors);
}
