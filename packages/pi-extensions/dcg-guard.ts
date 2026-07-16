// Block destructive Pi shell tool calls with Destructive Command Guard (dcg).
// https://github.com/Dicklesworthstone/destructive_command_guard
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const DCG_BIN = process.env.DCG_BIN ?? "dcg";

type DcgDecision = { deny: boolean; reason: string };

function dcgDecision(command: string): Promise<DcgDecision> {
  return new Promise((resolve) => {
    const child = spawn(DCG_BIN, ["--robot", "test", command], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let settled = false;
    let stdout = "";

    const finish = (decision: DcgDecision) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    // Fail open if dcg cannot run, matching dcg's other agent integrations.
    child.on("error", () => finish({ deny: false, reason: "" }));

    child.on("close", (code) => {
      if (code !== 1) {
        // 0 = allowed; >=3 = dcg error -> fail open.
        finish({ deny: false, reason: "" });
        return;
      }

      let reason = "Blocked by dcg (destructive command).";
      try {
        const parsed = JSON.parse(stdout) as {
          reason?: unknown;
          rule_id?: unknown;
        };
        if (typeof parsed.reason === "string") reason = parsed.reason;
        if (typeof parsed.rule_id === "string") reason += ` [${parsed.rule_id}]`;
      } catch {
        // Keep the default reason when dcg emits malformed output.
      }

      finish({ deny: true, reason });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input?.command ?? "");
    if (!command.trim()) return;

    const { deny, reason } = await dcgDecision(command);
    if (!deny) return;

    // Two hard-won clarifications for the agent reading this denial:
    //
    // 1. dcg vetoes the ENTIRE tool call — in a chained command
    //    (`a && b && c`) nothing ran, including the safe segments before
    //    the flagged one. An agent that assumes partial execution will
    //    mis-recover (this caused an orphaned-commit near-miss when a
    //    `git merge && git branch -f` chain was blocked pre-execution).
    //
    // 2. dcg pattern-matches the raw command string, so dangerous-looking
    //    text embedded as DATA (quoted JSON payloads, commit-message
    //    bodies, echo arguments) can trigger it — see upstream #124,
    //    #195, #196. The workaround is to keep such text out of bash
    //    command lines (write it to a file with the write tool instead).
    const guidance =
      "\n\nNothing was executed — dcg blocks the whole command, including any " +
      "safe segments of a chain, before anything runs. If the flagged text is " +
      "embedded DATA (a quoted payload/message, not an actual command), write " +
      "it to a file with the write tool and reference the file instead. If the " +
      "operation is genuinely intended, ask the user to run it manually or to " +
      "approve it via `dcg allow-once`.";
    return { block: true, reason: reason + guidance };
  });
}
