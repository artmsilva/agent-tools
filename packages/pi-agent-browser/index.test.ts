import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArgv, runProcess, screenshotPath, toModelText, truncate } from "./index.ts";

test("buildArgv appends --json to browser commands", () => {
   assert.deepEqual(buildArgv(["open", "https://example.com"]), ["open", "https://example.com", "--json"]);
});

test("buildArgv leaves self-documenting subcommands alone", () => {
   assert.deepEqual(buildArgv(["skills", "get", "core"]), ["skills", "get", "core"]);
   assert.deepEqual(buildArgv(["--help"]), ["--help"]);
});

test("buildArgv does not duplicate --json", () => {
   assert.deepEqual(buildArgv(["snapshot", "--json"]), ["snapshot", "--json"]);
});

test("toModelText converts JSON to TOON", () => {
   const out = toModelText(JSON.stringify({ users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] }));
   assert.match(out, /users\[2\]/);
   assert.match(out, /Alice/);
});

test("toModelText passes non-JSON through", () => {
   assert.equal(toModelText("plain text\n"), "plain text");
});

test("truncate caps long output", () => {
   const out = truncate("x".repeat(60_000), 50_000);
   assert.ok(out.length < 60_000);
   assert.match(out, /truncated 10000 chars/);
});

test("screenshotPath finds image path only for screenshot calls", () => {
   assert.equal(screenshotPath(["screenshot", "/tmp/a.png"]), "/tmp/a.png");
   assert.equal(screenshotPath(["open", "x.png"]), undefined);
   assert.equal(screenshotPath(["screenshot"]), undefined);
});

test("runProcess settles after abort when a descendant keeps stdio open", async () => {
   const controller = new AbortController();
   const script = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      "setInterval(() => {}, 1000);",
   ].join("\n");
   const startedAt = Date.now();
   const resultPromise = runProcess(process.execPath, ["-e", script], undefined, 5_000, controller.signal);
   setTimeout(() => controller.abort(), 200);

   const result = await resultPromise;

   assert.equal(result.aborted, true);
   assert.ok(Date.now() - startedAt < 1_000, "abort should not wait for inherited stdio to close");
});
