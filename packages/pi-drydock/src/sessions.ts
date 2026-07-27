import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Transform, Writable, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createBoundedTextCollector } from "./bounded-text.ts";

const SESSION_PREFIX = "drydock-";
const TMUX_SERVER = "pi-drydock";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 64 * 1024;
const STDOUT_LIMIT = 16 * 1024 * 1024;
const MAX_CAPTURE_LINES = 10_000;

export interface DrydockSessionManagerOptions {
  containerExecutable?: string;
  container: string;
  operationTimeoutMs?: number;
}

export interface DrydockSessionInfo {
  id: string;
  attached: boolean;
  createdAt: string;
}

export interface AttachedDrydockSession {
  readonly input: Writable;
  readonly output: Readable;
  readonly error: Readable;
  readonly closed: Promise<void>;
  detach(): void;
}

export class DrydockSessionManager {
  readonly #executable: string;
  readonly #container: string;
  readonly #timeoutMs: number;

  constructor(options: DrydockSessionManagerOptions) {
    this.#executable = options.containerExecutable ?? "container";
    this.#container = options.container;
    this.#timeoutMs = options.operationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async start(command: string, args: string[] = []): Promise<DrydockSessionInfo> {
    assertCommand(command);
    args.forEach(assertArgument);
    const id = randomUUID();
    const target = sessionTarget(id);
    await this.#run(["new-session", "-d", "-s", target, "-c", "/workspace", "--", "sleep", "infinity"]);
    try {
      await this.#run(["set-option", "-t", target, "remain-on-exit", "on"]);
      await this.#run(["set-option", "-t", target, "history-limit", String(MAX_CAPTURE_LINES)]);
      await this.#run(["respawn-pane", "-k", "-t", target, "-c", "/workspace", "--", command, ...args]);
    } catch (error) {
      await this.#run(["kill-session", "-t", target]).catch(() => undefined);
      throw error;
    }
    return { id, attached: false, createdAt: new Date().toISOString() };
  }

  async list(): Promise<DrydockSessionInfo[]> {
    const result = await this.#runResult([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_attached}\t#{session_created}",
    ]);
    if (result.exitCode !== 0 && isMissingTmuxSession(result.stderr)) return [];
    assertSuccess(result, "list sessions");
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map(parseSessionLine)
      .filter((session): session is DrydockSessionInfo => session !== undefined)
      .sort(compareSessions);
  }

  attach(id: string): AttachedDrydockSession {
    const target = sessionTarget(id);
    const child = spawn(this.#executable, this.#containerAttachArgs(["-C", "attach-session", "-t", target]));
    return attachedSession(child, target, this.#timeoutMs);
  }

  async capture(id: string, lines: number = 200): Promise<string> {
    assertCaptureLines(lines);
    const result = await this.#run(["capture-pane", "-p", "-t", sessionTarget(id), "-S", `-${lines}`]);
    return result.stdout;
  }

  async resize(id: string, columns: number, rows: number): Promise<void> {
    assertDimension(columns, "columns");
    assertDimension(rows, "rows");
    await this.#run(["resize-window", "-t", sessionTarget(id), "-x", String(columns), "-y", String(rows)]);
  }

  async isRunning(id: string): Promise<boolean> {
    const result = await this.#runResult(["display-message", "-p", "-t", sessionTarget(id), "#{pane_dead}"]);
    if (result.exitCode !== 0 && isMissingTmuxSession(result.stderr)) return false;
    assertSuccess(result, "inspect tmux session");
    return parsePaneRunning(result.stdout, id);
  }

  async stop(id: string): Promise<void> {
    const result = await this.#runResult(["kill-session", "-t", sessionTarget(id)]);
    if (result.exitCode !== 0 && isMissingTmuxSession(result.stderr)) return;
    assertSuccess(result, "tmux kill-session");
  }

  async #run(tmuxArgs: string[]): Promise<ProcessResult> {
    const result = await this.#runResult(tmuxArgs);
    assertSuccess(result, `tmux ${tmuxArgs[0] ?? "command"}`);
    return result;
  }

  #runResult(tmuxArgs: string[]): Promise<ProcessResult> {
    return runProcess(this.#executable, this.#containerExecArgs(tmuxArgs), this.#timeoutMs);
  }

  #containerAttachArgs(tmuxArgs: string[]): string[] {
    const args = this.#containerExecArgs(tmuxArgs);
    args.splice(1, 0, "--interactive");
    return args;
  }

  #containerExecArgs(tmuxArgs: string[]): string[] {
    return [
      "exec",
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--workdir",
      "/workspace",
      this.#container,
      "tmux",
      "-L",
      TMUX_SERVER,
      ...tmuxArgs,
    ];
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runProcess(executable: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args);
    const stdout: Buffer[] = [];
    const stderr = createBoundedTextCollector(child.stderr, STDERR_LIMIT);
    let stdoutBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > STDOUT_LIMIT) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stdin.end();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`Drydock session operation timed out after ${timeoutMs}ms`));
      else if (outputExceeded) reject(new Error(`Drydock session output exceeded ${STDOUT_LIMIT} bytes`));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderr(), exitCode: code ?? -1 });
    });
  });
}

function attachedSession(
  child: ChildProcessWithoutNullStreams,
  target: string,
  detachTimeoutMs: number,
): AttachedDrydockSession {
  let detaching = false;
  let settled = false;
  let detachTimeout: NodeJS.Timeout | undefined;
  const output = tmuxOutput(child.stdout);
  const errorDiagnostic = createBoundedTextCollector(child.stderr, STDERR_LIMIT);
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      if (detachTimeout) clearTimeout(detachTimeout);
      finishAttachment(resolve, reject, code, signal, detaching, errorDiagnostic);
    });
  });
  return {
    input: tmuxInput(child.stdin, target),
    output,
    error: child.stderr,
    closed,
    detach() {
      if (detaching || settled) return;
      detaching = true;
      detachTimeout = setTimeout(() => child.kill("SIGKILL"), detachTimeoutMs);
      child.stdin.end("detach-client\n");
    },
  };
}

function finishAttachment(
  resolve: () => void,
  reject: (error: Error) => void,
  code: number | null,
  signal: NodeJS.Signals | null,
  detaching: boolean,
  errorDiagnostic: () => string,
): void {
  if (detaching) return resolve();
  if (code === 0) return resolve();
  reject(
    new Error(`Drydock session attachment failed (${attachmentExitReason(code, signal)}): ${errorDiagnostic().trim()}`),
  );
}

function attachmentExitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return signal;
  if (code === null) return "exit -1";
  return `exit ${code}`;
}

function tmuxInput(input: Writable, target: string): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) return callback();
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
      input.write(`send-keys -t ${target} -H ${hex}\n`, callback);
    },
  });
}

function tmuxOutput(input: Readable): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return input.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        pending += decoder.write(chunk);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const output = parseTmuxOutput(line);
          if (output) this.push(output);
        }
        callback();
      },
      flush(callback) {
        pending += decoder.end();
        const output = parseTmuxOutput(pending);
        if (output) this.push(output);
        callback();
      },
    }),
  );
}

function parseTmuxOutput(line: string): Buffer | undefined {
  if (!line.startsWith("%output ")) return undefined;
  const payloadStart = line.indexOf(" ", 8);
  if (payloadStart === -1) return undefined;
  return decodeTmuxEscapes(line.slice(payloadStart + 1));
}

function decodeTmuxEscapes(value: string): Buffer {
  const chunks: Buffer[] = [];
  let plainStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") continue;
    chunks.push(Buffer.from(value.slice(plainStart, index)));
    const decoded = decodeTmuxEscape(value, index);
    chunks.push(Buffer.from([decoded.byte]));
    index = decoded.lastIndex;
    plainStart = index + 1;
  }
  chunks.push(Buffer.from(value.slice(plainStart)));
  return Buffer.concat(chunks);
}

function decodeTmuxEscape(value: string, slashIndex: number): { byte: number; lastIndex: number } {
  const octal = value.slice(slashIndex + 1, slashIndex + 4);
  if (/^[0-7]{3}$/.test(octal)) return { byte: Number.parseInt(octal, 8), lastIndex: slashIndex + 3 };
  if (slashIndex + 1 < value.length) return { byte: value.charCodeAt(slashIndex + 1), lastIndex: slashIndex + 1 };
  return { byte: "\\".charCodeAt(0), lastIndex: slashIndex };
}

function parsePaneRunning(output: string, id: string): boolean {
  const paneDead = output.trim();
  if (paneDead === "0") return true;
  if (paneDead === "1") return false;
  throw new Error(`Invalid Drydock session state: ${id}`);
}

function parseSessionLine(line: string): DrydockSessionInfo | undefined {
  const [name, attached, created] = line.split("\t");
  if (!isDrydockSessionName(name)) return undefined;
  const id = name.slice(SESSION_PREFIX.length);
  if (!SESSION_ID_PATTERN.test(id)) return undefined;
  const createdAt = parseSessionCreatedAt(created);
  if (!createdAt) return undefined;
  return { id, attached: attached === "1", createdAt };
}

function isDrydockSessionName(name: string | undefined): name is string {
  return typeof name === "string" && name.startsWith(SESSION_PREFIX);
}

function parseSessionCreatedAt(value: string | undefined): string | undefined {
  const createdSeconds = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(createdSeconds)) return undefined;
  if (createdSeconds <= 0) return undefined;
  return new Date(createdSeconds * 1000).toISOString();
}

function sessionTarget(id: string): string {
  assertSessionId(id);
  return `${SESSION_PREFIX}${id}`;
}

function assertSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid Drydock session ID: ${id}`);
}

function assertCommand(command: string): void {
  if (!command || command.includes("\0")) throw new Error("Invalid Drydock session command");
}

function assertArgument(value: string): void {
  if (value.includes("\0")) throw new Error("Invalid Drydock session argument");
}

function isMissingTmuxSession(stderr: string): boolean {
  return /can't find session|no server running|failed to connect|error connecting.*no such/i.test(stderr);
}

function assertCaptureLines(lines: number): void {
  if (!Number.isSafeInteger(lines) || lines <= 0 || lines > MAX_CAPTURE_LINES) {
    throw new Error(`Invalid Drydock session capture lines: ${lines}`);
  }
}

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error(`Invalid Drydock session ${label}: ${value}`);
}

function assertSuccess(result: ProcessResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`Drydock ${operation} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

function compareSessions(left: DrydockSessionInfo, right: DrydockSessionInfo): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

