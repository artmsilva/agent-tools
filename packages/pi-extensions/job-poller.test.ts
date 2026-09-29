import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jobPoller, { readJobStatus } from "./job-poller.ts";

test("detects pending, failed, and successful jobs", () => {
   const dir = mkdtempSync(join(tmpdir(), "pi-job-poller-"));
   const output = join(dir, "result.json");
   const log = join(dir, "job.log");

   assert.equal(readJobStatus(output, log), "pending");
   writeFileSync(log, "Fatal: generation failed\n");
   assert.equal(readJobStatus(output, log), "failed");
   writeFileSync(output, "[]\n");
   assert.equal(readJobStatus(output, log), "succeeded");
});

test("steers completion into an active turn instead of queuing a follow-up", async () => {
   const dir = mkdtempSync(join(tmpdir(), "pi-job-poller-"));
   const output = join(dir, "result.json");
   writeFileSync(output, "[]\n");

   let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
   let delivery: unknown;
   jobPoller({
      registerTool: (registered: typeof tool) => {
         tool = registered;
      },
      registerCommand: () => {},
      on: () => {},
      sendMessage: (_message: unknown, options: unknown) => {
         delivery = options;
      },
   } as never);

   await tool!.execute("id", { outputPath: output });

   assert.deepEqual(delivery, { triggerTurn: true, deliverAs: "steer" });
});
