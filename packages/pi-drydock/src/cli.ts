import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { createAnthropicCredentialHeadersResolver } from "./anthropic-connector.ts";
import { DrydockControlPlane, type DrydockControlPlaneOptions } from "./control-plane.ts";

const MODEL = "claude-haiku-4-5";
const CONNECTOR_TTL_MS = 12 * 60 * 60_000;
const DETACH_BYTE = 0x1d; // Ctrl+]

interface CliInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
}

interface CliOutput {
  write(chunk: string | Uint8Array): unknown;
  columns?: number;
  rows?: number;
}

export interface DrydockCliOptions {
  control?: DrydockControlPlane;
  cwd?: string;
  stdin?: CliInput;
  stdout?: CliOutput;
  stderr?: CliOutput;
  signal?: AbortSignal;
  containerExecutable?: string;
  stateRoot?: string;
}

const USAGE = `Usage: drydock <command> [arguments]

  system start                Start Apple container services
  image [tag]                 Build the Guest image
  create <name> [source]      Create, import a Git worktree, and hibernate
  list                        List named Drydocks
  run <name> [pi args...]     Run Pi inside a Guest with a host Connector
  exec <name> <shell command> Run one command and return the Guest to cold state
  sessions <name>             List Guest sessions
  attach <name> <session>     Attach to a running Guest session (Ctrl+] detaches)
  capture <name> <session> [lines]
  resize <name> <session> <columns> <rows>
  stop <name> <session>
  checkpoint <name>           Create a checkpoint
  checkpoints <name>          List checkpoints
  restore <name> <checkpoint>
  export <name>               Write a reviewed patch handoff
  hibernate <name>            Persist files and discard active compute
  reconcile                   Recover orphaned compute after an unclean exit
  destroy <name>              Destroy a Drydock
`;

interface CliContext {
  control: DrydockControlPlane;
  options: DrydockCliOptions;
  stdout: CliOutput;
  stderr: CliOutput;
}

type CliCommand = (args: string[], context: CliContext) => Promise<number>;

const COMMANDS: Record<string, CliCommand> = {
  system: commandSystem,
  image: commandImage,
  create: commandCreate,
  list: commandList,
  run: commandRun,
  exec: commandExec,
  sessions: commandSessions,
  attach: commandAttach,
  capture: commandCapture,
  resize: commandResize,
  stop: commandStop,
  checkpoint: commandCheckpoint,
  checkpoints: commandCheckpoints,
  restore: commandRestore,
  export: commandExport,
  hibernate: commandHibernate,
  reconcile: commandReconcile,
  destroy: commandDestroy,
};

export async function runDrydockCli(args: string[], options: DrydockCliOptions = {}): Promise<number> {
  if (isHelp(args[0])) return showHelp(options.stdout);
  return requireCommand(args[0])(args.slice(1), createCliContext(options));
}

function showHelp(output: CliOutput = process.stdout): number {
  output.write(USAGE);
  return 0;
}

function requireCommand(name: string): CliCommand {
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown Drydock command: ${name}\n\n${USAGE}`);
  return command;
}

function createCliContext(options: DrydockCliOptions): CliContext {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return { control: options.control ?? createControlPlane(options, stderr), options, stdout, stderr };
}

function isHelp(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
}

async function commandSystem(args: string[], context: CliContext): Promise<number> {
  if (args[0] !== "start") throw new Error(`Unknown system command: ${args[0] ?? ""}`);
  await runInherited(context.options.containerExecutable, ["system", "start"], context.options.signal, "Drydock system start");
  return 0;
}

async function commandImage(args: string[], context: CliContext): Promise<number> {
  await buildImage(args[0] ?? "pi-drydock-pi:latest", context.options.containerExecutable, context.options.signal);
  return 0;
}

async function commandCreate(args: string[], context: CliContext): Promise<number> {
  await createDrydock(context.control, required(args[0], "name"), args[1] ?? context.options.cwd ?? process.cwd(), context.stdout);
  return 0;
}

async function commandList(_args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.list());
  return 0;
}

async function commandRun(args: string[], context: CliContext): Promise<number> {
  await runPi(context.control, required(args[0], "name"), args.slice(1), context.options);
  return 0;
}

function commandExec(args: string[], context: CliContext): Promise<number> {
  if (args.length !== 2) throw new Error("Pass the shell command as one quoted argument");
  return execCommand(context.control, required(args[0], "name"), required(args[1], "shell command"), context.stdout, context.stderr);
}

async function commandSessions(args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.listSessions(required(args[0], "name")));
  return 0;
}

async function commandAttach(args: string[], context: CliContext): Promise<number> {
  await attach(context.control, required(args[0], "name"), required(args[1], "session ID"), context.options, false);
  return 0;
}

async function commandCapture(args: string[], context: CliContext): Promise<number> {
  context.stdout.write(await context.control.captureSession(required(args[0], "name"), required(args[1], "session ID"), optionalInteger(args[2])));
  return 0;
}

async function commandResize(args: string[], context: CliContext): Promise<number> {
  await context.control.resizeSession(
    required(args[0], "name"),
    required(args[1], "session ID"),
    requiredInteger(args[2], "columns"),
    requiredInteger(args[3], "rows"),
  );
  return 0;
}

async function commandStop(args: string[], context: CliContext): Promise<number> {
  await context.control.stopSession(required(args[0], "name"), required(args[1], "session ID"));
  return 0;
}

async function commandCheckpoint(args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.checkpoint(required(args[0], "name")));
  return 0;
}

async function commandCheckpoints(args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.listCheckpoints(required(args[0], "name")));
  return 0;
}

async function commandRestore(args: string[], context: CliContext): Promise<number> {
  await context.control.restoreCheckpoint(required(args[0], "name"), required(args[1], "checkpoint ID"));
  return 0;
}

async function commandExport(args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await withOpen(context.control, required(args[0], "name"), (name) => context.control.exportWorkspace(name)));
  return 0;
}

async function commandHibernate(args: string[], context: CliContext): Promise<number> {
  await context.control.hibernate(required(args[0], "name"));
  return 0;
}

async function commandReconcile(_args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.reconcile());
  return 0;
}

async function commandDestroy(args: string[], context: CliContext): Promise<number> {
  await context.control.destroy(required(args[0], "name"));
  return 0;
}

function createControlPlane(options: DrydockCliOptions, stderr: CliOutput): DrydockControlPlane {
  const controlOptions: DrydockControlPlaneOptions = {
    stateRoot: options.stateRoot ?? process.env.DRYDOCK_STATE_ROOT,
    containerExecutable: options.containerExecutable ?? process.env.DRYDOCK_CONTAINER,
    idleTimeoutMs: 0,
    onBackgroundError: (error, name) => stderr.write(`[pi-drydock:${name}] ${error.message}\n`),
  };
  return new DrydockControlPlane(controlOptions);
}

async function createDrydock(
  control: DrydockControlPlane,
  name: string,
  sourceRoot: string,
  stdout: CliOutput,
): Promise<void> {
  const identity = await control.create(name);
  try {
    await control.open(name);
    const workspace = await control.importWorkspace(name, sourceRoot);
    await control.hibernate(name);
    writeJson(stdout, { ...identity, workspace });
  } catch (error) {
    await control.destroy(name).catch(() => undefined);
    throw error;
  }
}

async function execCommand(
  control: DrydockControlPlane,
  name: string,
  command: string,
  stdout: CliOutput,
  stderr: CliOutput,
): Promise<number> {
  const result = await withOpen(control, name, (activeName) => control.exec(activeName, command));
  stdout.write(result.stdout);
  stderr.write(result.stderr);
  return result.exitCode;
}

async function runPi(
  control: DrydockControlPlane,
  name: string,
  piArgs: string[],
  options: DrydockCliOptions,
): Promise<void> {
  await withOpen(control, name, async (activeName) => {
    const connector = await control.openConnector(activeName, {
      policy: {
        provider: "anthropic",
        model: MODEL,
        upstreamOrigin: "https://api.anthropic.com",
        allowedPath: "/v1/messages",
        maxRequestBytes: 20 * 1024 * 1024,
        maxResponseBytes: 20 * 1024 * 1024,
        maxConcurrent: 1,
        requestsPerMinute: 30,
        timeoutMs: 5 * 60_000,
        fixedHeaders: { "anthropic-version": "2023-06-01" },
      },
      resolveCredentialHeaders: createAnthropicCredentialHeadersResolver(),
      capabilityTtlMs: CONNECTOR_TTL_MS,
    });
    try {
      options.stderr?.write(`Connector expires ${connector.expiresAt}\n`);
      const session = await control.startSession(activeName, "pi", [
        "-e",
        "/run/pi-drydock/pi-provider.ts",
        "--provider",
        "drydock-anthropic",
        "--model",
        MODEL,
        ...piArgs,
      ]);
      (options.stderr ?? process.stderr).write(`Drydock session ${session.id}; Ctrl+] detaches without stopping Pi.\n`);
      await attach(control, activeName, session.id, options, true);
    } finally {
      await connector.close();
    }
  });
}

async function attach(
  control: DrydockControlPlane,
  name: string,
  id: string,
  options: DrydockCliOptions,
  keepOwnerAlive: boolean,
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const attachment = await control.attachSession(name, id);
  const interaction = connectTerminal(attachment, stdin, stdout, options.signal);
  const stopped = waitForSessionExit(control, name, id, options.signal);
  const first = await Promise.race([
    interaction.then(() => "detached" as const),
    stopped.then(() => "stopped" as const),
  ]);
  await finishAttachment(first, attachment, stopped, keepOwnerAlive, stderr, id);
}

async function finishAttachment(
  first: "detached" | "stopped",
  attachment: Awaited<ReturnType<DrydockControlPlane["attachSession"]>>,
  stopped: Promise<void>,
  keepOwnerAlive: boolean,
  stderr: CliOutput,
  id: string,
): Promise<void> {
  if (first === "stopped") {
    attachment.detach();
    return attachment.closed;
  }
  if (!keepOwnerAlive) return;
  stderr.write(`Detached; owner remains foreground until session ${id} exits.\n`);
  await stopped;
}

function connectTerminal(
  attachment: Awaited<ReturnType<DrydockControlPlane["attachSession"]>>,
  stdin: CliInput,
  stdout: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const wasRaw = Boolean(stdin.isTTY);
  const onOutput = (chunk: Buffer) => stdout.write(chunk);
  const onInput = (chunk: Buffer) => {
    const detachAt = wasRaw ? chunk.indexOf(DETACH_BYTE) : -1;
    if (detachAt === -1) attachment.input.write(chunk);
    else {
      if (detachAt > 0) attachment.input.write(chunk.subarray(0, detachAt));
      attachment.detach();
    }
  };
  const onAbort = () => attachment.detach();
  attachment.output.on("data", onOutput);
  stdin.on("data", onInput);
  if (wasRaw) stdin.setRawMode?.(true);
  signal?.addEventListener("abort", onAbort, { once: true });
  return attachment.closed.finally(() => {
    signal?.removeEventListener("abort", onAbort);
    stdin.off("data", onInput);
    attachment.output.off("data", onOutput);
    if (wasRaw) stdin.setRawMode?.(false);
  });
}

async function waitForSessionExit(
  control: DrydockControlPlane,
  name: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  while (await control.isSessionRunning(name, id)) await delay(250, undefined, { signal });
}

async function withOpen<T>(control: DrydockControlPlane, name: string, operation: (name: string) => Promise<T>): Promise<T> {
  await control.open(name);
  let failure: unknown;
  try {
    return await operation(name);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await control.hibernate(name);
    } catch (hibernateError) {
      if (failure) throw new AggregateError([failure, hibernateError], `Drydock operation and hibernation failed: ${name}`);
      throw hibernateError;
    }
  }
}

async function buildImage(tag: string, executable: string | undefined, signal?: AbortSignal): Promise<void> {
  const context = join(import.meta.dirname, "..", "image");
  await runInherited(
    executable,
    ["build", "--platform", "linux/arm64", "--dns", process.env.DRYDOCK_BUILD_DNS ?? "1.1.1.1", "--tag", tag, context],
    signal,
    "Drydock image build",
  );
}

async function runInherited(
  executable = process.env.DRYDOCK_CONTAINER ?? "container",
  args: string[],
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> {
  const child = spawn(executable, args, { stdio: "inherit", signal });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) throw new Error(`${operation} failed (exit ${exitCode})`);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}\n\n${USAGE}`);
  return value;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return requiredInteger(value, "integer");
}

function requiredInteger(value: string | undefined, label: string): number {
  const parsed = Number(required(value, label));
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}
