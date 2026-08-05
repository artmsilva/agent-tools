import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanToolspace } from "./scanner.mjs";

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("maps tool ownership without exposing configuration values", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-toolspace-"));
  mkdirSync(join(home, ".pi", "agent", "skills", "focused", ""), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "skills", "focused", "SKILL.md"), "# Focused");
  mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
  writeFileSync(join(home, "linked-agent.md"), "---\nname: linked\n---");
  symlinkSync(join(home, "linked-agent.md"), join(home, ".pi", "agent", "agents", "linked.md"));
  symlinkSync(join(home, "missing-agent.md"), join(home, ".pi", "agent", "agents", "broken.md"));
  mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
  writeFileSync(join(home, "linked-command.md"), "# Command");
  symlinkSync(join(home, "linked-command.md"), join(home, ".pi", "agent", "prompts", "linked.md"));
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(join(home, "linked-extension.ts"), "export default () => {};");
  symlinkSync(join(home, "linked-extension.ts"), join(home, ".pi", "agent", "extensions", "linked.ts"));
  writeJson(join(home, ".pi", "agent", "settings.json"), {
    defaultModel: "test-model",
    defaultProvider: "test-provider",
    apiKey: "do-not-expose",
    packages: ["npm:pi-claude-bridge"],
  });
  writeJson(join(home, ".pi", "agent", "mcp.json"), {
    mcpServers: { shared: { command: "shared-mcp", env: { TOKEN: "secret-mcp-value" } } },
    imports: ["claude-code"],
  });
  writeJson(join(home, ".claude", "settings.json"), {
    enabledPlugins: { "ready@marketplace": true, "missing@marketplace": true },
    hooks: { SessionStart: [] },
  });
  writeJson(join(home, ".claude.json"), {
    mcpServers: { shared: { command: "shared-mcp" }, remote: { url: "https://example.test/mcp" } },
  });
  writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
    plugins: { "ready@marketplace": [{ version: "1.2.3", installPath: "/plugin" }] },
  });

  const snapshot = scanToolspace({ home });

  assert.equal(snapshot.pi.model, "test-model");
  assert.deepEqual(snapshot.pi.resources.skills, ["focused"]);
  assert.deepEqual(snapshot.pi.resources.agents, ["linked"]);
  assert.deepEqual(snapshot.pi.resources.commands, ["linked"]);
  assert.deepEqual(snapshot.pi.resources.extensions, ["linked.ts"]);
  assert.deepEqual(snapshot.shared.mcpOverrides, ["shared"]);
  assert.deepEqual(snapshot.claude.plugins.map((plugin) => plugin.name), ["missing@marketplace", "ready@marketplace"]);
  assert.deepEqual(snapshot.health, ["Pi agent: broken.md", "Enabled plugin not installed: missing@marketplace"]);
  assert.equal(JSON.stringify(snapshot).includes("do-not-expose"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret-mcp-value"), false);
});
