import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArgv, screenshotPath, toModelText, truncate } from "./index.ts";

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
