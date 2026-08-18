import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { siblingContextBlock } from "./context-file-sibling.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sibling-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

test("injects the CLAUDE.md that pi skipped in favour of AGENTS.md", () => {
  const dir = repo({
    "AGENTS.md": "Read and follow CLAUDE.md.",
    "CLAUDE.md": "# CLAUDE.md\n\nSecrets live in the 1Password Environment.",
  });

  const block = siblingContextBlock([join(dir, "AGENTS.md")]);

  assert.match(block, /Secrets live in the 1Password Environment/);
  assert.match(block, /Additional project instructions/);
});

test("adds nothing when the sibling is missing", () => {
  const dir = repo({ "AGENTS.md": "Only file here." });

  assert.equal(siblingContextBlock([join(dir, "AGENTS.md")]), "");
});

test("adds nothing when the sibling is already loaded", () => {
  const dir = repo({ "AGENTS.md": "one", "CLAUDE.md": "two" });

  const block = siblingContextBlock([join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")]);

  assert.equal(block, "");
});

test("does not double-inject through an AGENTS.md -> CLAUDE.md symlink", () => {
  const dir = repo({ "CLAUDE.md": "# CLAUDE.md\n\nOne source of truth." });
  symlinkSync("CLAUDE.md", join(dir, "AGENTS.md"));

  assert.equal(siblingContextBlock([join(dir, "AGENTS.md")]), "");
});

test("respects a deliberate AGENTS.override.md", () => {
  const dir = repo({
    "AGENTS.override.md": "This replaces the others.",
    "CLAUDE.md": "Should stay out of the prompt.",
  });

  const block = siblingContextBlock([join(dir, "AGENTS.override.md")]);

  assert.equal(block, "");
});

test("names an oversized sibling instead of pasting it", () => {
  const dir = repo({ "AGENTS.md": "pointer", "CLAUDE.md": `# Big\n\n${"x".repeat(4096)}` });

  const block = siblingContextBlock([join(dir, "AGENTS.md")], { maxBytes: 1024 });

  assert.match(block, /NOT LOADED \(4\.0 KB\)/);
  assert.match(block, /Read it with the read tool/);
  assert.doesNotMatch(block, /xxxxxxxx/);
});

test("stops pasting once the total budget is spent", () => {
  const outer = repo({
    "AGENTS.md": "outer pointer",
    "CLAUDE.md": `# Outer\n\n${"a".repeat(900)}`,
    "nested/AGENTS.md": "inner pointer",
    "nested/CLAUDE.md": `# Inner\n\n${"b".repeat(900)}`,
  });

  const block = siblingContextBlock(
    [join(outer, "AGENTS.md"), join(outer, "nested/AGENTS.md")],
    { maxBytes: 4096, totalBytes: 1000 },
  );

  assert.match(block, /# Outer/);
  assert.doesNotMatch(block, /bbbbbbbb/);
  assert.match(block, /nested\/CLAUDE\.md — NOT LOADED/);
});

test("skips a blank sibling", () => {
  const dir = repo({ "AGENTS.md": "pointer", "CLAUDE.md": "   \n\n" });

  assert.equal(siblingContextBlock([join(dir, "AGENTS.md")]), "");
});
