import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderDrydockResult, runDrydock } from "./src/drydock.ts";

export default function activate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "drydock_bash",
    label: "Drydock Bash",
    description:
      "Run one shell command in an ephemeral Apple container with Git-tracked workspace files, no guest network, and no host writes. Returns stdout, stderr, exit code, and a text patch; never applies the patch.",
    promptSnippet: "Run a shell command in an isolated Apple container and return a reviewable text patch",
    promptGuidelines: [
      "Use drydock_bash for untrusted shell commands that do not need network access.",
      "drydock_bash never applies its returned patch; review it before changing host files.",
      "drydock_bash is experimental and text-patch-only; use normal tools for binary changes.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run from the copied workspace root." }),
      timeoutSeconds: Type.Optional(
        Type.Number({ minimum: 1, maximum: 300, description: "Command timeout in seconds. Default 120." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx?.cwd) throw new Error("drydock_bash requires an execution working directory");
      const result = await runDrydock({
        command: params.command,
        cwd: ctx.cwd,
        timeoutMs: (params.timeoutSeconds ?? 120) * 1000,
        signal,
      });
      return {
        content: [{ type: "text", text: renderDrydockResult(result) }],
        details: result,
      };
    },
  });
}
