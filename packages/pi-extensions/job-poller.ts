import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type JobStatus = "pending" | "succeeded" | "failed";

export function readJobStatus(outputPath: string, logPath?: string): JobStatus {
   if (existsSync(outputPath) && statSync(outputPath).size > 0) return "succeeded";
   if (!logPath || !existsSync(logPath)) return "pending";
   const log = readFileSync(logPath, "utf8");
   return /Fatal:|failed; output was not replaced|batch not started/i.test(log)
      ? "failed"
      : "pending";
}

export default function activate(pi: ExtensionAPI) {
   let timer: NodeJS.Timeout | undefined;

   const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
   };

   const start = (outputPath: string, logPath?: string) => {
      stop();
      const check = () => {
         const status = readJobStatus(outputPath, logPath);
         if (status === "pending") return;
         stop();
         pi.sendMessage(
            {
               customType: "job-poller",
               content: `Background job ${basename(outputPath)} ${status}. Inspect ${outputPath}${logPath ? ` and ${logPath}` : ""}, then report the result to the user.`,
               display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
         );
      };

      timer = setInterval(check, 5_000);
      timer.unref();
      check();
   };

   pi.registerTool({
      name: "poll_job",
      label: "Poll Background Job",
      description: "Watch a background job and wake the agent when its output appears or its log reports failure.",
      promptSnippet: "Watch a background job to completion without asking the user to poll",
      promptGuidelines: [
         "After starting a background job, call poll_job yourself; do not ask the user to run /poll-job.",
      ],
      parameters: Type.Object({
         outputPath: Type.String({ description: "Output file whose non-empty presence means success." }),
         logPath: Type.Optional(Type.String({ description: "Log file checked for fatal failure messages." })),
      }),
      async execute(_id, { outputPath, logPath }) {
         start(outputPath, logPath);
         return {
            content: [{ type: "text", text: `Polling ${outputPath}` }],
            details: { outputPath, logPath },
         };
      },
   });

   pi.registerCommand("poll-job", {
      description: "Report when a background job finishes: /poll-job <output> [log]",
      handler: async (args, ctx) => {
         const [outputPath, logPath] = args.trim().split(/\s+/);
         if (!outputPath) {
            ctx.ui.notify("Usage: /poll-job <output> [log]", "warning");
            return;
         }
         start(outputPath, logPath);
         ctx.ui.notify(`Polling ${outputPath}`, "info");
      },
   });

   pi.registerCommand("poll-job-stop", {
      description: "Stop the active background-job poller",
      handler: async (_args, ctx) => {
         stop();
         ctx.ui.notify("Background-job poller stopped", "info");
      },
   });

   pi.on("session_shutdown", stop);
}
