import { spawn } from "node:child_process";
import { join } from "node:path";
import { createAnthropicCredentialHeadersResolver } from "./anthropic-connector.ts";
import { DrydockControlPlane, type DrydockControlPlaneOptions } from "./control-plane.ts";

const MODEL = "claude-haiku-4-5";
const CONNECTOR_TTL_MS = 12 * 60 * 60_000;

interface CliOutput {
  write(chunk: string | Uint8Array): unknown;
}

export interface DrydockCliOptions {
  control?: DrydockControlPlane;
  cwd?: string;
  stdout?: CliOutput;
  stderr?: CliOutput;
  signal?: AbortSignal;
  tty?: boolean;
  containerExecutable?: string;
  stateRoot?: string;
}

const USAGE = `Usage: drydock <command> [arguments]

  system start                Start Apple container services
  image [tag]                 Build the Guest image
  create <name> [source]      Create, import a Git worktree, and hibernate
  list                        List named Drydocks
  enter <name>                Enter a Guest shell with model access
  exec <name> <shell command> Run one command and return the Guest to cold state
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
  enter: commandEnter,
  exec: commandExec,
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

async function commandEnter(args: string[], context: CliContext): Promise<number> {
  if (args.length !== 1) throw new Error("Enter requires exactly one Drydock name");
  return enterDrydock(context.control, required(args[0], "name"), context.options);
}

function commandExec(args: string[], context: CliContext): Promise<number> {
  if (args.length !== 2) throw new Error("Pass the shell command as one quoted argument");
  return execCommand(context.control, required(args[0], "name"), required(args[1], "shell command"), context.stdout, context.stderr);
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

async function enterDrydock(
  control: DrydockControlPlane,
  name: string,
  options: DrydockCliOptions,
): Promise<number> {
  const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) throw new Error("drydock enter requires an interactive terminal");
  return withOpen(control, name, async (activeName) => {
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
      return await control.runForeground(activeName, "/bin/bash", ["-i"], {
        signal: options.signal,
        tty: true,
      });
    } finally {
      await connector.close();
    }
  });
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

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}
