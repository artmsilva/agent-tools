import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import vibes from "./index.ts";
import { computeMood, longRunningMood } from "./mood.ts";
import { familiarFrame } from "./familiar.ts";
import { shouldPlayLongToolSound } from "./soundtrack.ts";

test("computeMood returns green for empty events", () => {
  assert.equal(computeMood([]), "green");
});

test("computeMood returns red for 2 consecutive errors", () => {
  const events = [
    { isError: false, durationMs: 100 },
    { isError: true, durationMs: 200 },
    { isError: true, durationMs: 300 },
  ];
  assert.equal(computeMood(events), "red");
});

test("computeMood returns amber for slow tools", () => {
  const events = [
    { isError: false, durationMs: 11_000 },
    { isError: false, durationMs: 12_000 },
  ];
  assert.equal(computeMood(events), "amber");
});

test("computeMood returns amber for any error in window", () => {
  const events = [
    { isError: true, durationMs: 100 },
    { isError: false, durationMs: 200 },
  ];
  assert.equal(computeMood(events), "amber");
});

test("computeMood returns green for all ok", () => {
  const events = [
    { isError: false, durationMs: 100 },
    { isError: false, durationMs: 200 },
  ];
  assert.equal(computeMood(events), "green");
});

test("longRunningMood returns purple", () => {
  assert.equal(longRunningMood(), "purple");
});

test("familiarFrame idle blinks", () => {
  assert.equal(familiarFrame("idle", 0), "(o.o)");
  assert.equal(familiarFrame("idle", 5), "(-.-)");
  assert.equal(familiarFrame("idle", 10), "(o.o)");
});

test("familiarFrame running cycles", () => {
  assert.equal(familiarFrame("running", 0), "(o.o)");
  assert.equal(familiarFrame("running", 1), "(o_o)");
  assert.equal(familiarFrame("running", 2), "(o.o)");
  assert.equal(familiarFrame("running", 3), "(O_O)");
  assert.equal(familiarFrame("running", 4), "(o.o)");
});

test("familiarFrame error shows faint", () => {
  assert.equal(familiarFrame("error", 0), "(x.x)");
});

test("familiarFrame celebrate shows celebration", () => {
  assert.equal(familiarFrame("celebrate", 0), "\\(^o^)/");
});

test("shouldPlayLongToolSound returns true for >10s", () => {
  assert.equal(shouldPlayLongToolSound(10_001), true);
});

test("shouldPlayLongToolSound returns false for <=10s", () => {
  assert.equal(shouldPlayLongToolSound(10_000), false);
  assert.equal(shouldPlayLongToolSound(5_000), false);
});

test("scheduled status updates ignore stale session contexts", async () => {
  type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>;

  const handlers = new Map<string, Handler>();
  let timeoutCallback: (() => void) | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    timeoutCallback = callback;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;

  try {
    vibes({
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    } as unknown as ExtensionAPI);

    let stale = false;
    const ctx = {};
    Object.defineProperty(ctx, "ui", {
      get() {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        return {
          theme: { fg: (_color: string, text: string) => text },
          setStatus() {},
        };
      },
    });

    await handlers.get("tool_execution_start")?.({ toolCallId: "tool-1" }, ctx);
    assert.ok(timeoutCallback);
    stale = true;
    assert.doesNotThrow(timeoutCallback);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
