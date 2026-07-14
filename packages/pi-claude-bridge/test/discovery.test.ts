import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCommandContent } from "../extensions/claude-bridge/command-content.ts";
import {
  discoverCommandsInDir,
  discoverSkillsInDir,
  discoverAgentsInDir,
  extractDescription,
} from "../extensions/claude-bridge/discovery.ts";

describe("extractDescription", () => {
  test("frontmatter description wins", () => {
    expect(extractDescription('---\ndescription: "Do the thing"\n---\n# Title\n', "x")).toBe(
      "Do the thing",
    );
  });
  test("falls back to first heading, then first line", () => {
    expect(extractDescription("# My Command\nbody", "x")).toBe("My Command");
    expect(extractDescription("just a line", "x")).toBe("just a line");
    expect(extractDescription("", "x")).toBe("Claude command: /x");
  });
});

describe("discoverCommandsInDir", () => {
  test("nested dirs become ':' segments; plugin prefix applies", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cmds-"));
    try {
      mkdirSync(join(root, "xyz"), { recursive: true });
      writeFileSync(join(root, "test.md"), "# Test");
      writeFileSync(join(root, "xyz", "test1.md"), "# Nested");

      const bare = discoverCommandsInDir(root, "user");
      expect(bare.map((c) => c.name)).toEqual(["test", "xyz:test1"]);

      const prefixed = discoverCommandsInDir(root, "plugin:acme", "acme");
      expect(prefixed.map((c) => c.name)).toEqual(["acme:test", "acme:xyz:test1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("discoverSkillsInDir / discoverAgentsInDir", () => {
  test("skills need SKILL.md; agents are top-level .md files", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-skills-"));
    try {
      mkdirSync(join(root, "skills", "good"), { recursive: true });
      mkdirSync(join(root, "skills", "empty"), { recursive: true });
      writeFileSync(join(root, "skills", "good", "SKILL.md"), "---\ndescription: A skill\n---\n");
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(join(root, "agents", "reviewer.md"), "# Reviewer");
      writeFileSync(join(root, "agents", "notes.txt"), "not an agent");

      const skills = discoverSkillsInDir(join(root, "skills"), "test");
      expect(skills.map((s) => s.name)).toEqual(["good"]);
      expect(skills[0]?.description).toBe("A skill");

      const agents = discoverAgentsInDir(join(root, "agents"), "test");
      expect(agents.map((a) => a.name)).toEqual(["reviewer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignored skill names are skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-skills-"));
    try {
      mkdirSync(join(root, "nope"), { recursive: true });
      writeFileSync(join(root, "nope", "SKILL.md"), "# nope");
      expect(discoverSkillsInDir(root, "test", new Set(["nope"]))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadCommandContent ($ARGUMENTS substitution)", () => {
  test("replaces placeholders and strips frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-content-"));
    try {
      const file = join(root, "cmd.md");
      writeFileSync(file, "---\ndescription: d\n---\nReview $ARGUMENTS now");
      expect(loadCommandContent(file, "PR #7")).toBe("Review PR #7 now");
      expect(loadCommandContent(file)).toBe("Review now");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appends args when no placeholder present", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-content-"));
    try {
      const file = join(root, "cmd.md");
      writeFileSync(file, "Do the task.");
      expect(loadCommandContent(file, "extra")).toBe("Do the task.\n\nextra");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
