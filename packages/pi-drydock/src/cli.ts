import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DrydockControlPlane,
  type DrydockControlPlaneOptions,
  type DrydockStartupTelemetry,
} from "./control-plane.ts";
import { createHostModelConnector, type HostModelConnector } from "./model-connector.ts";
import {
  herdrContextFromEnvironment,
  startHerdrPiReporter,
  type HerdrContext,
} from "./herdr-reporter.ts";

const CONNECTOR_TTL_MS = 12 * 60 * 60_000;
const GUEST_PATH = "/run/pi-drydock/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const execFileAsync = promisify(execFile);

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
  herdr?: HerdrContext;
  herdrPollIntervalMs?: number;
  containerExecutable?: string;
  stateRoot?: string;
  modelConnector?: HostModelConnector;
  dotfilesRoot?: string;
  dotfilesInstallCommand?: string;
}

const USAGE = `Usage: drydock <command> [arguments]

  setup                       Start Apple services and build the Guest image
  system start                Start Apple container services
  image [tag]                 Build the Guest image
  create <name> [source]      Create, import tracked files/dotfiles, and hibernate
  use <name>                  Select a bound Drydock for this Git project
  list                        List named Drydocks
  enter [name]                Wake, measure startup, and enter the Guest shell
  exec [name] <shell command> Run one command and return the Guest to cold state
  checkpoint [name]           Create a checkpoint
  checkpoints [name]          List checkpoints
  restore [name] <checkpoint>
  export [name]               Write a reviewed patch handoff
  hibernate [name]            Persist files and discard active compute
  reconcile                   Recover orphaned compute after an unclean exit
  destroy [name]              Destroy a Drydock
  docs [topic]                Read built-in docs (dotfiles, models, telemetry)
  help [topic]                Show this help or one docs topic

Environment:
  DRYDOCK_DOTFILES_ROOT       Dedicated tracked Guest-only dotfiles repository
  DRYDOCK_DOTFILES_INSTALL    Optional offline installer command
  DRYDOCK_STATE_ROOT          Host-only durable state and local telemetry root
  DRYDOCK_CONTAINER           Apple container executable
`;

const DOCS: Readonly<Record<string, string>> = {
  dotfiles: `Bring your own dotfiles

Set DRYDOCK_DOTFILES_ROOT to a dedicated, secret-free Git repository before
running drydock create. Only tracked regular text files are copied into
/home/node. Do not use a general personal dotfiles checkout.

Optionally set DRYDOCK_DOTFILES_INSTALL to a repository-relative command such
as ./install.sh. It runs offline as Guest UID 1000 without host credentials.
Symlinks, credential paths, private keys, 1Password references, and likely
literal secrets are rejected. Recreate a Drydock to apply later changes.
`,
  models: `Host models and 1Password

Drydock exposes the host Pi model catalog inside the Guest while keeping API
keys, OAuth tokens, endpoints, and custom headers on the host. Configure models
in the normal host Pi configuration. Host models.json auth commands such as
!op read 'op://Vault/Item/credential' are resolved by the host; neither the op
session nor the resolved value enters the Guest.
`,
  telemetry: `Startup telemetry

Each drydock enter atomically replaces:
  <state root>/<name>/startup-telemetry.json

startedAt is the command-start timestamp. durationMs measures through launch of
the interactive Apple container exec. It excludes shell prompt rendering and
first model token. Telemetry remains local and is never transmitted.
`,
};

interface CliContext {
  control: DrydockControlPlane;
  options: DrydockCliOptions;
  stdout: CliOutput;
  stderr: CliOutput;
}

type CliCommand = (args: string[], context: CliContext) => Promise<number>;

const COMMANDS: Record<string, CliCommand> = {
  setup: commandSetup,
  system: commandSystem,
  image: commandImage,
  create: commandCreate,
  use: commandUse,
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
  docs: commandDocs,
};

export async function runDrydockCli(args: string[], options: DrydockCliOptions = {}): Promise<number> {
  if (args[0] === "help" && args[1]) return showDocs(args.slice(1), options.stdout);
  if (isHelp(args[0])) return showHelp(options.stdout);
  return requireCommand(args[0])(args.slice(1), createCliContext(options));
}

function showHelp(output: CliOutput = process.stdout): number {
  output.write(USAGE);
  return 0;
}

function showDocs(args: string[], output: CliOutput = process.stdout): number {
  if (args.length > 1) throw new Error("Docs accepts at most one topic");
  if (!args[0]) {
    output.write(`Available docs: ${Object.keys(DOCS).join(", ")}\n`);
    return 0;
  }
  const document = DOCS[args[0]];
  if (!document) throw new Error(`Unknown Drydock docs topic: ${args[0]}`);
  output.write(document);
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

async function commandDocs(args: string[], context: CliContext): Promise<number> {
  return showDocs(args, context.stdout);
}

async function commandSetup(args: string[], context: CliContext): Promise<number> {
  if (args.length !== 0) throw new Error("Setup does not accept arguments");
  await runInherited(context.options.containerExecutable, ["system", "start"], context.options.signal, "Drydock system start");
  await buildImage("pi-drydock-pi:latest", context.options.containerExecutable, context.options.signal);
  return 0;
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
  await createDrydock(
    context.control,
    required(args[0], "name"),
    args[1] ?? context.options.cwd ?? process.cwd(),
    context.options,
    context.stdout,
  );
  return 0;
}

async function commandUse(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Use accepts at most one Drydock name");
  const root = await gitRoot(context.options.cwd);
  if (args.length === 0) {
    context.stdout.write(`${await selectedDrydock(root)}\n`);
    return 0;
  }
  const name = required(args[0], "name");
  const binding = await context.control.getWorkspaceBinding(name);
  if (binding.sourceRoot !== root) throw new Error(`Drydock ${name} is bound to a different Git project`);
  await execFileAsync("git", ["-C", root, "config", "--local", "pi-drydock.name", name]);
  context.stdout.write(`${name}\n`);
  return 0;
}

async function commandList(_args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.list());
  return 0;
}

async function commandEnter(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Enter accepts at most one Drydock name");
  const measurement = { startedAt: new Date().toISOString(), startedAtMs: performance.now() };
  const name = args[0] ?? await selectedDrydock(await gitRoot(context.options.cwd));
  return enterDrydock(context.control, name, context.options, measurement);
}

async function commandExec(args: string[], context: CliContext): Promise<number> {
  if (args.length < 1 || args.length > 2) throw new Error("Pass the shell command as one quoted argument");
  const name = await selectedOrNamed(args.length === 2 ? args[0] : undefined, context.options);
  return execCommand(context.control, name, required(args.at(-1), "shell command"), context.stdout, context.stderr);
}

async function commandCheckpoint(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Checkpoint accepts at most one Drydock name");
  writeJson(context.stdout, await context.control.checkpoint(await selectedOrNamed(args[0], context.options)));
  return 0;
}

async function commandCheckpoints(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Checkpoints accepts at most one Drydock name");
  writeJson(context.stdout, await context.control.listCheckpoints(await selectedOrNamed(args[0], context.options)));
  return 0;
}

async function commandRestore(args: string[], context: CliContext): Promise<number> {
  if (args.length < 1 || args.length > 2) throw new Error("Restore requires a checkpoint ID and optional Drydock name");
  const name = await selectedOrNamed(args.length === 2 ? args[0] : undefined, context.options);
  await context.control.restoreCheckpoint(name, required(args.at(-1), "checkpoint ID"));
  return 0;
}

async function commandExport(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Export accepts at most one Drydock name");
  const name = await selectedOrNamed(args[0], context.options);
  writeJson(context.stdout, await withOpen(context.control, name, () => context.control.exportWorkspace(name)));
  return 0;
}

async function commandHibernate(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Hibernate accepts at most one Drydock name");
  await context.control.hibernate(await selectedOrNamed(args[0], context.options));
  return 0;
}

async function commandReconcile(_args: string[], context: CliContext): Promise<number> {
  writeJson(context.stdout, await context.control.reconcile());
  return 0;
}

async function commandDestroy(args: string[], context: CliContext): Promise<number> {
  if (args.length > 1) throw new Error("Destroy accepts at most one Drydock name");
  await context.control.destroy(await selectedOrNamed(args[0], context.options));
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
  options: DrydockCliOptions,
  stdout: CliOutput,
): Promise<void> {
  const identity = await control.create(name);
  try {
    await control.open(name);
    const dotfiles = await installConfiguredDotfiles(control, name, options);
    const workspace = await control.importWorkspace(name, sourceRoot);
    await control.hibernate(name);
    writeJson(stdout, { ...identity, workspace, ...(dotfiles ? { dotfiles } : {}) });
  } catch (error) {
    await control.destroy(name).catch(() => undefined);
    throw error;
  }
}

async function installConfiguredDotfiles(
  control: DrydockControlPlane,
  name: string,
  options: DrydockCliOptions,
) {
  const root = options.dotfilesRoot ?? process.env.DRYDOCK_DOTFILES_ROOT;
  if (!root) return undefined;
  const installer = options.dotfilesInstallCommand ?? process.env.DRYDOCK_DOTFILES_INSTALL;
  return control.installDotfiles(name, root, installer);
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
  measurement: { startedAt: string; startedAtMs: number },
): Promise<number> {
  const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) throw new Error("drydock enter requires an interactive terminal");
  return withOpen(control, name, (activeName) => runEnteredDrydock(control, activeName, options, measurement));
}

async function runEnteredDrydock(
  control: DrydockControlPlane,
  activeName: string,
  options: DrydockCliOptions,
  measurement: { startedAt: string; startedAtMs: number },
): Promise<number> {
    const models = await resolveModelConnector(options.modelConnector);
    const connector = await control.openConnector(activeName, {
      policy: {
        provider: "host-pi",
        model: models.catalog.defaultModel.model,
        allowedModels: models.catalog.providers.flatMap((provider) =>
          provider.models.map((model) => ({ provider: provider.id, model: model.id })),
        ),
        upstreamOrigin: "https://model-connector.invalid",
        allowedPath: "/model-stream",
        maxRequestBytes: 20 * 1024 * 1024,
        maxResponseBytes: 20 * 1024 * 1024,
        maxConcurrent: 1,
        requestsPerMinute: 30,
        timeoutMs: 5 * 60_000,
      },
      resolveCredentialHeaders: async () => ({}),
      handleRequest: models.handleRequest,
      modelCatalog: models.catalog,
      capabilityTtlMs: CONNECTOR_TTL_MS,
    });
    const reporter = createHerdrReporter(control, activeName, options);
    let telemetryWrite = Promise.resolve();
    try {
      return await control.runForeground(activeName, "/bin/bash", ["-i"], {
        signal: options.signal,
        tty: true,
        environment: { PATH: GUEST_PATH },
        onSpawn: () => {
          telemetryWrite = recordStartupTelemetry(control, activeName, measurement, options);
        },
      });
    } finally {
      await telemetryWrite;
      try {
        await reporter?.close();
      } finally {
        await connector.close();
      }
    }
}

async function recordStartupTelemetry(
  control: DrydockControlPlane,
  name: string,
  measurement: { startedAt: string; startedAtMs: number },
  options: DrydockCliOptions,
): Promise<void> {
  const telemetry: DrydockStartupTelemetry = {
    startedAt: measurement.startedAt,
    durationMs: Math.round(performance.now() - measurement.startedAtMs),
  };
  try {
    await control.recordStartupTelemetry(name, telemetry);
  } catch (error) {
    errorOutput(options).write(`[pi-drydock:telemetry] ${(error as Error).message}\n`);
  }
}

async function resolveModelConnector(configured: HostModelConnector | undefined): Promise<HostModelConnector> {
  if (configured) return configured;
  return createHostModelConnector();
}

function createHerdrReporter(control: DrydockControlPlane, drydock: string, options: DrydockCliOptions) {
  const herdr = options.herdr ?? herdrContextFromEnvironment();
  if (!herdr) return undefined;
  return startHerdrPiReporter({
    ...herdr,
    control,
    drydock,
    pollIntervalMs: options.herdrPollIntervalMs ?? 500,
    onError: (error) => errorOutput(options).write(`[pi-drydock:herdr] ${error.message}\n`),
  });
}

function errorOutput(options: DrydockCliOptions): CliOutput {
  return options.stderr ?? process.stderr;
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

async function gitRoot(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return realpath(stdout.trim());
  } catch {
    throw new Error("Run this command inside a Git project");
  }
}

async function selectedOrNamed(name: string | undefined, options: DrydockCliOptions): Promise<string> {
  return name ?? selectedDrydock(await gitRoot(options.cwd));
}

async function selectedDrydock(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "config", "--local", "--get", "pi-drydock.name"], {
      encoding: "utf8",
    });
    return required(stdout.trim(), "selected Drydock");
  } catch {
    throw new Error("No Drydock selected for this Git project; run: drydock use <name>");
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}\n\n${USAGE}`);
  return value;
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}
