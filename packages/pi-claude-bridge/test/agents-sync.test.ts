import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncAgentLinks } from "../extensions/claude-bridge/agents-sync.ts";
import type { BridgeAgent } from "../extensions/claude-bridge/types.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bridge-agents-"));
  const agentsDir = join(root, "agents");
  const sourcesDir = join(root, "sources");
  const manifest = join(root, "state.json");
  mkdirSync(sourcesDir, { recursive: true });
  return { root, agentsDir, sourcesDir, manifest };
}

function makeAgent(sourcesDir: string, name: string): BridgeAgent {
  const absolutePath = join(sourcesDir, `${name}.md`);
  writeFileSync(absolutePath, `# ${name}\n`);
  return { name, absolutePath, source: "test" };
}

describe("syncAgentLinks", () => {
  test("creates links and records them in the manifest", () => {
    const { root, agentsDir, sourcesDir, manifest } = setup();
    try {
      const agent = makeAgent(sourcesDir, "reviewer");
      const result = syncAgentLinks([agent], agentsDir, manifest);

      expect(result.created).toEqual(["reviewer.md"]);
      expect(readlinkSync(join(agentsDir, "reviewer.md"))).toBe(agent.absolutePath);
      const state = JSON.parse(readFileSync(manifest, "utf-8")) as { agentLinks: Record<string, string> };
      expect(state.agentLinks["reviewer.md"]).toBe(agent.absolutePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent and prunes stale bridge-owned links", () => {
    const { root, agentsDir, sourcesDir, manifest } = setup();
    try {
      const a = makeAgent(sourcesDir, "a");
      const b = makeAgent(sourcesDir, "b");
      syncAgentLinks([a, b], agentsDir, manifest);

      // Second run: no changes.
      const second = syncAgentLinks([a, b], agentsDir, manifest);
      expect(second.created).toEqual([]);
      expect(second.pruned).toEqual([]);

      // Drop b -> its link is pruned; a stays.
      const third = syncAgentLinks([a], agentsDir, manifest);
      expect(third.pruned).toEqual(["b.md"]);
      expect(() => lstatSync(join(agentsDir, "b.md"))).toThrow();
      expect(readlinkSync(join(agentsDir, "a.md"))).toBe(a.absolutePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retargets a managed link when the source path changes (plugin update)", () => {
    const { root, agentsDir, sourcesDir, manifest } = setup();
    try {
      const v1 = makeAgent(join(sourcesDir), "agent");
      syncAgentLinks([v1], agentsDir, manifest);

      const v2Dir = join(sourcesDir, "v2");
      mkdirSync(v2Dir);
      const v2 = makeAgent(v2Dir, "agent");
      const result = syncAgentLinks([v2], agentsDir, manifest);

      expect(result.updated).toEqual(["agent.md"]);
      expect(readlinkSync(join(agentsDir, "agent.md"))).toBe(v2.absolutePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never touches files or symlinks it did not create", () => {
    const { root, agentsDir, sourcesDir, manifest } = setup();
    try {
      mkdirSync(agentsDir, { recursive: true });
      // Foreign regular file + foreign symlink (e.g. install.sh-managed).
      writeFileSync(join(agentsDir, "mine.md"), "user content");
      const foreignTarget = join(sourcesDir, "foreign-target.md");
      writeFileSync(foreignTarget, "# foreign\n");
      symlinkSync(foreignTarget, join(agentsDir, "linked.md"));

      const mine = makeAgent(sourcesDir, "mine");
      const linked = makeAgent(sourcesDir, "linked");
      const result = syncAgentLinks([mine, linked], agentsDir, manifest);

      expect(result.skipped.sort()).toEqual(["linked.md", "mine.md"]);
      expect(readFileSync(join(agentsDir, "mine.md"), "utf-8")).toBe("user content");
      expect(readlinkSync(join(agentsDir, "linked.md"))).toBe(foreignTarget);

      // And pruning never removes them either.
      const prune = syncAgentLinks([], agentsDir, manifest);
      expect(prune.pruned).toEqual([]);
      expect(readFileSync(join(agentsDir, "mine.md"), "utf-8")).toBe("user content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips agents whose source file is missing", () => {
    const { root, agentsDir, sourcesDir, manifest } = setup();
    try {
      const ghost: BridgeAgent = { name: "ghost", absolutePath: join(sourcesDir, "ghost.md"), source: "test" };
      const result = syncAgentLinks([ghost], agentsDir, manifest);
      expect(result.created).toEqual([]);
      expect(() => lstatSync(join(agentsDir, "ghost.md"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
