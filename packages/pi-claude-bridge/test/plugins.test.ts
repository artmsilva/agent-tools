import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersionsDesc,
  parsePluginKey,
  pickNewestVersion,
  readEnabledPlugins,
  resolvePluginRoot,
} from "../extensions/claude-bridge/plugins.ts";

describe("parsePluginKey", () => {
  test("splits name@marketplace", () => {
    expect(parsePluginKey("remember@claude-plugins-official")).toEqual({
      name: "remember",
      marketplace: "claude-plugins-official",
    });
  });

  test("uses the last @ for scoped-ish names", () => {
    expect(parsePluginKey("a@b@mp")).toEqual({ name: "a@b", marketplace: "mp" });
  });

  test("rejects malformed keys", () => {
    expect(parsePluginKey("no-marketplace")).toBeUndefined();
    expect(parsePluginKey("@mp")).toBeUndefined();
    expect(parsePluginKey("name@")).toBeUndefined();
  });
});

describe("readEnabledPlugins", () => {
  test("keeps only entries set to true", () => {
    const plugins = readEnabledPlugins({
      enabledPlugins: {
        "remember@claude-plugins-official": true,
        "disabled@claude-plugins-official": false,
        "hb-design-system@hummingbird-ai": true,
      },
    });
    expect(plugins).toEqual([
      { name: "remember", marketplace: "claude-plugins-official" },
      { name: "hb-design-system", marketplace: "hummingbird-ai" },
    ]);
  });

  test("tolerates missing/invalid settings", () => {
    expect(readEnabledPlugins(null)).toEqual([]);
    expect(readEnabledPlugins({})).toEqual([]);
    expect(readEnabledPlugins({ enabledPlugins: "nope" })).toEqual([]);
  });
});

describe("version sorting", () => {
  test("semver-ish descending", () => {
    expect(compareVersionsDesc("1.1.1", "0.9.9")).toBeLessThan(0);
    expect(compareVersionsDesc("0.8.2", "0.8.3")).toBeGreaterThan(0);
    expect(compareVersionsDesc("1.2", "1.2.0")).toBeGreaterThan(0); // longer wins on tie prefix
  });

  test("picks the newest version", () => {
    expect(pickNewestVersion(["0.8.2", "0.8.3"])).toBe("0.8.3");
    expect(pickNewestVersion(["1.1.1", "1.10.0", "1.9.9"])).toBe("1.10.0");
  });

  test("tolerates 'unknown' -- numeric versions win", () => {
    expect(pickNewestVersion(["unknown", "0.0.1"])).toBe("0.0.1");
    expect(pickNewestVersion(["unknown"])).toBe("unknown");
    expect(pickNewestVersion([])).toBeUndefined();
  });
});

describe("resolvePluginRoot", () => {
  test("prefers marketplaces dir when it exists", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "bridge-plugins-"));
    try {
      const marketRoot = join(claudeDir, "plugins", "marketplaces", "mp", "plugins", "p1");
      mkdirSync(marketRoot, { recursive: true });
      mkdirSync(join(claudeDir, "plugins", "cache", "mp", "p1", "9.9.9"), { recursive: true });

      expect(resolvePluginRoot(claudeDir, { name: "p1", marketplace: "mp" })).toBe(marketRoot);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("falls back to newest cache version dir", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "bridge-plugins-"));
    try {
      mkdirSync(join(claudeDir, "plugins", "cache", "mp", "p2", "0.8.2"), { recursive: true });
      mkdirSync(join(claudeDir, "plugins", "cache", "mp", "p2", "0.8.3"), { recursive: true });

      expect(resolvePluginRoot(claudeDir, { name: "p2", marketplace: "mp" })).toBe(
        join(claudeDir, "plugins", "cache", "mp", "p2", "0.8.3"),
      );
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("returns undefined when the plugin is not on disk", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "bridge-plugins-"));
    try {
      expect(resolvePluginRoot(claudeDir, { name: "ghost", marketplace: "mp" })).toBeUndefined();
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});
