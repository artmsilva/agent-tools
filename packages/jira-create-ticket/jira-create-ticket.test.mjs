import assert from "node:assert/strict";
import test from "node:test";
import { markdownToWiki, parseArgs } from "./jira-create-ticket.mjs";

test("converts basic Markdown to Jira wiki markup", () => {
  assert.equal(markdownToWiki("## Scope\n- **Run** `tests`\n[Docs](https://example.com)"), "h2. Scope\n* *Run* {{tests}}\n[Docs|https://example.com]");
});

test("parses create and repair arguments", () => {
  assert.deepEqual(parseArgs(["-s", "Title", "-d", "Body", "-p", "3"]), { summary: "Title", description: "Body", points: 3 });
  assert.deepEqual(parseArgs(["--fix", "ABC-123"]), { fix: "ABC-123", points: undefined });
});

test("rejects invalid points", () => {
  assert.throws(() => parseArgs(["-s", "Title", "-p", "nope"]), /Points/);
});
