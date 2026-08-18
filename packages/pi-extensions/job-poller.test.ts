import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJobStatus } from "./job-poller.ts";

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
