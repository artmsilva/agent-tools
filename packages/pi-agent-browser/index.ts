/**
 * pi-agent-browser — lean pi extension exposing the agent-browser CLI as a native tool.
 *
 * Spirit of pi-agent-browser-native, minus the orchestration layer:
 * - Pass exact CLI args; the CLI self-documents (`skills get core`).
 * - JSON output is re-encoded as TOON (https://github.com/toon-format/toon) to cut tokens.
 * - Errors are ALWAYS thrown (text-only) — a failed call can never produce an
 *   image + isError tool_result, which Anthropic rejects and which permanently
 *   poisons a session (the bug that motivated this fork).
 * - Screenshots are attached as image content on success only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { encode } from "@toon-format/toon";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_OUTPUT_BYTES = 50_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Subcommands that don't speak --json (self-documentation / setup). */
const NO_JSON_SUBCOMMANDS = new Set(["skills", "install", "help", "--help", "-h", "--version", "-V"]);

/** Append --json unless the subcommand doesn't support it or it's already there. */
export function buildArgv(args: string[]): string[] {
   if (args.length === 0) return args;
   if (NO_JSON_SUBCOMMANDS.has(args[0])) return args;
   if (args.includes("--json")) return args;
   return [...args, "--json"];
}

export function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
   if (text.length <= limit) return text;
   return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

/** JSON stdout → TOON for the model; non-JSON passes through untouched. */
export function toModelText(stdout: string): string {
   const trimmed = stdout.trim();
   if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return truncate(trimmed);
   try {
      return truncate(encode(JSON.parse(trimmed)));
   } catch {
      return truncate(trimmed);
   }
}

/** Screenshot path from args, when this call is a screenshot with an explicit file. */
export function screenshotPath(args: string[]): string | undefined {
   if (args[0] !== "screenshot") return undefined;
   const candidate = args.slice(1).find((a) => /\.(png|jpe?g)$/i.test(a));
   return candidate;
}

interface RunResult {
   stdout: string;
   stderr: string;
   code: number | null;
   timedOut: boolean;
}

function run(argv: string[], stdin: string | undefined, timeoutMs: number, signal: AbortSignal | undefined): Promise<RunResult> {
   return new Promise((resolve, reject) => {
      const child = spawn("agent-browser", argv, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
         timedOut = true;
         child.kill("SIGKILL");
      }, timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => {
         clearTimeout(timer);
         reject(new Error(`Failed to spawn agent-browser: ${err.message}. Is it installed? (npm i -g agent-browser)`));
      });
      child.on("close", (code) => {
         clearTimeout(timer);
         signal?.removeEventListener("abort", onAbort);
         resolve({ stdout, stderr, code, timedOut });
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
   });
}

export default function activate(pi: ExtensionAPI) {
   pi.registerTool({
      name: "agent_browser",
      label: "Agent Browser",
      description: [
         "Browser automation via the agent-browser CLI. Pass exact CLI arguments (no shell quoting, no --json — it is added automatically and the JSON result is returned as TOON).",
         "Core loop: `open <url>` → `snapshot -i` (interactive elements with @eN refs) → `click @e3` / `fill @e2 <text>` → re-snapshot after navigation or DOM changes.",
         "Extraction: `get text <sel>`, `get title`, `get url`. Screenshots: `screenshot <path.png>` (image attached on success).",
         "First time in a session, run `skills get core` — the CLI serves its own up-to-date workflow guide. `skills list` shows specialized guides (electron, slack, dogfood).",
      ].join("\n"),
      promptSnippet:
         "Browser automation via the agent-browser CLI: open pages, snapshot with @refs, click/fill, extract content, screenshot",
      promptGuidelines: [
         "For agent_browser, run `skills get core` once per session before non-trivial automation; the CLI self-documents.",
         "agent_browser loop: open → snapshot -i → act on @refs → re-snapshot after navigation or DOM changes.",
         "Stop before order/purchase/final-submit actions and ask the user.",
      ],
      parameters: Type.Object({
         args: Type.Array(Type.String(), {
            minItems: 1,
            description: "Exact agent-browser CLI arguments, e.g. [\"open\", \"https://example.com\"] or [\"snapshot\", \"-i\"]. Do not include --json.",
         }),
         stdin: Type.Optional(Type.String({ description: "Raw stdin content (for batch / eval --stdin)." })),
         timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Watchdog timeout in ms. Default 120000." })),
      }),
      async execute(_toolCallId, params, signal) {
         const argv = buildArgv(params.args);
         const result = await run(argv, params.stdin, params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);

         if (result.timedOut) {
            throw new Error(`agent-browser timed out after ${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.\n${truncate(result.stderr || result.stdout)}`);
         }
         if (result.code !== 0) {
            // Text-only by construction: thrown errors become isError:true text results.
            throw new Error(truncate([`agent-browser exited with code ${result.code}`, result.stderr.trim(), toModelText(result.stdout)].filter(Boolean).join("\n\n")));
         }

         const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
            { type: "text", text: toModelText(result.stdout) || "(no output)" },
         ];

         const shot = screenshotPath(params.args);
         if (shot) {
            try {
               if (statSync(shot).size <= MAX_IMAGE_BYTES) {
                  content.push({
                     type: "image",
                     data: readFileSync(shot).toString("base64"),
                     mimeType: shot.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
                  });
               } else {
                  content[0].type === "text" && (content[0].text += `\n\nScreenshot saved to ${shot} (too large to attach inline).`);
               }
            } catch {
               // ponytail: screenshot attach is best-effort; the text result already reports the path
            }
         }

         return { content, details: { argv, exitCode: result.code } };
      },
   });
}
