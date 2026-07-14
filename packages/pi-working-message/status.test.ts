import { describe, expect, test } from "bun:test";
import { createStatusTracker, describeTool, formatElapsed, safeDescribeTool } from "./status";

describe("formatElapsed", () => {
	test.each([
		[0, "0s"],
		[999, "0s"],
		[1000, "1s"],
		[59_000, "59s"],
		[60_000, "1m 00s"],
		[61_000, "1m 01s"],
		[3_600_000, "1h 00m"],
		[3_661_000, "1h 01m"],
	] as const)("formats %dms as %s", (ms, expected) => {
		expect(formatElapsed(ms)).toBe(expected);
	});

	test("clamps negative elapsed (clock skew) to 0s instead of showing a negative time", () => {
		expect(formatElapsed(-5000)).toBe("0s");
	});

	test("handles NaN/non-finite input without throwing or printing NaN", () => {
		expect(() => formatElapsed(Number.NaN)).not.toThrow();
		expect(formatElapsed(Number.NaN)).not.toContain("NaN");
		expect(() => formatElapsed(Number.POSITIVE_INFINITY)).not.toThrow();
		expect(formatElapsed(Number.POSITIVE_INFINITY)).not.toContain("Infinity");
	});
});

describe("describeTool", () => {
	test("bash with no args does not crash and omits literal 'undefined'", () => {
		const result = describeTool("bash", undefined);
		expect(result).not.toContain("undefined");
	});

	test.each([
		["read", "Reading"],
		["edit", "Editing"],
		["write", "Writing"],
	] as const)(
		"%s with a real path uses the %s label",
		(toolName, label) => {
			expect(describeTool(toolName, { path: "/tmp/foo.ts" })).toContain(label);
		},
	);

	test.each(["read", "edit", "write"])(
		"%s with missing/non-string path falls back cleanly (no 'undefined', no trailing empty path)",
		(toolName) => {
			for (const args of [{}, { path: 123 }, { path: "" }]) {
				const result = describeTool(toolName, args as Record<string, unknown>);
				expect(result).not.toContain("undefined");
				expect(result.trim().endsWith(" ")).toBe(false);
			}
		},
	);

	test("truncates a very long multiline command to a single bounded-length line", () => {
		const longCommand = "echo " + "a".repeat(100) + "\nsecond line\nthird line";
		const result = describeTool("bash", { command: longCommand });
		expect(result).not.toContain("\n");
		expect(result.length).toBeLessThanOrEqual("Running: ".length + 48);
		expect(result.endsWith("…")).toBe(true);
	});

	test("strips ANSI escapes and control chars from bash command", () => {
		const evil = "echo \x1b[31mhi\x1b[0m\x07\ndone";
		const result = describeTool("bash", { command: evil });
		expect(result).not.toMatch(/\x1b|\x07/);
		expect(result).not.toContain("\n");
	});

	test("strips ANSI escapes from a path", () => {
		const evil = "/tmp/\x1b[31mfoo\x1b[0m.ts";
		const result = describeTool("read", { path: evil });
		expect(result).not.toMatch(/\x1b/);
	});

	test("grep/glob/find fall back cleanly with no pattern/query", () => {
		for (const toolName of ["grep", "glob", "find"]) {
			const result = describeTool(toolName, {});
			expect(result).not.toContain("undefined");
		}
		expect(describeTool("grep", { pattern: "foo" })).toContain("foo");
	});

	test("fetch falls back cleanly with no url", () => {
		expect(describeTool("fetch", {})).not.toContain("undefined");
		expect(describeTool("fetch", { url: "https://example.com" })).toContain("example.com");
	});

	test("unrecognized mcp__server__tool name formats as 'server: tool'", () => {
		expect(describeTool("mcp__slack__send_message", {})).toBe("slack: send_message");
	});

	test("malformed mcp-like name (no double underscore) falls back to generic label, not a crash", () => {
		expect(() => describeTool("mcp__onlyoneseparator", {})).not.toThrow();
		expect(describeTool("mcp__onlyoneseparator", {})).not.toContain("undefined");
	});
});

describe("safeDescribeTool", () => {
	test("never throws, even when args access throws, and falls back to the tool name", () => {
		const hostileArgs = new Proxy(
			{},
			{
				get() {
					throw new Error("boom");
				},
			},
		) as Record<string, unknown>;

		let result = "";
		expect(() => {
			result = safeDescribeTool("read", hostileArgs);
		}).not.toThrow();
		expect(result).toContain("read");
	});

	test("passes through normal describeTool output unchanged", () => {
		expect(safeDescribeTool("read", { path: "/tmp/foo.ts" })).toBe(
			describeTool("read", { path: "/tmp/foo.ts" }),
		);
	});
});

describe("createStatusTracker", () => {
	test("idle default is never the literal 'Thinking...' (or containing 'Thinking')", () => {
		const tracker = createStatusTracker();
		expect(tracker.message()).not.toContain("Thinking");
	});

	test("ending an id that was never started is a no-op", () => {
		const tracker = createStatusTracker();
		tracker.start("a", "read", { path: "/tmp/foo.ts" });
		expect(() => tracker.end("nonexistent-id")).not.toThrow();
		// state for the real in-flight tool must be untouched
		expect(tracker.message()).toContain("Reading");
	});

	test("reset clears stuck entries (e.g. dropped end events) back to idle, never 'Thinking...'", () => {
		const tracker = createStatusTracker();
		tracker.start("a", "read", { path: "/tmp/foo.ts" });
		tracker.start("b", "bash", { command: "npm test" });
		// no end() calls — simulates events dropped/lost across a reconnect
		tracker.reset();
		expect(tracker.message()).not.toContain("Thinking");
		expect(tracker.message()).not.toContain("Reading");
	});

	test("with multiple active tools, shows latest plus a count of the rest", () => {
		const tracker = createStatusTracker();
		tracker.start("a", "read", { path: "/tmp/foo.ts" });
		tracker.start("b", "bash", { command: "npm test" });
		tracker.start("c", "edit", { path: "/tmp/bar.ts" });
		const msg = tracker.message();
		expect(msg).toContain("Editing");
		expect(msg).toContain("+2 more");
	});

	test("waitStart shows a live-ticking 'waiting for model' status with elapsed time, not 'Thinking...'", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.waitStart("anthropic/claude-sonnet-4-5");
		clock = 4000;
		const msg = tracker.message();
		expect(msg).not.toContain("Thinking");
		expect(msg).toContain("anthropic/claude-sonnet-4-5");
		expect(msg).toContain("4s");
	});

	test("waitStart with unknown model still shows elapsed, no 'undefined'", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.waitStart(undefined);
		clock = 2000;
		const msg = tracker.message();
		expect(msg).not.toContain("undefined");
		expect(msg).toContain("2s");
	});

	test("waiting past the stall threshold surfaces a visible stall warning", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.waitStart("anthropic/claude-sonnet-4-5");
		clock = 5000;
		expect(tracker.message()).not.toMatch(/stall|⚠/i);
		clock = 20_000;
		expect(tracker.message()).toMatch(/stall|⚠/i);
	});

	test("streamStart shows a live-ticking streaming status, not 'Thinking...'", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 3000;
		const msg = tracker.message();
		expect(msg).not.toContain("Thinking");
		expect(msg).toMatch(/stream/i);
		expect(msg).toContain("3s");
	});

	test("streaming stalls (no new tokens) past the idle threshold surfaces a stall warning", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 5000;
		tracker.streamToken(); // token arrives at 5s, resets idle clock
		clock = 10_000; // only 5s idle since last token — fine
		expect(tracker.message()).not.toMatch(/stall|⚠/i);
		clock = 25_000; // 20s idle since last token — stalled
		expect(tracker.message()).toMatch(/stall|⚠/i);
	});

	test("streamToken called with no streamStart (out-of-order events) does not throw", () => {
		const tracker = createStatusTracker();
		expect(() => tracker.streamToken()).not.toThrow();
	});

	test("a tool starting while waiting/streaming overrides the phase back to tool status", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 1000;
		tracker.start("a", "bash", { command: "npm test" });
		expect(tracker.message()).toContain("npm test");
		expect(tracker.message()).not.toMatch(/stream/i);
	});

	test("agent_start-style reset while a tool is stuck active still returns to idle, not 'Thinking...'", () => {
		const tracker = createStatusTracker();
		tracker.waitStart("anthropic/claude-sonnet-4-5");
		tracker.reset();
		expect(tracker.message()).not.toContain("Thinking");
		expect(tracker.message()).not.toContain("Waiting");
	});

	test("a long-running tool must NOT leave a false stall warning once it finishes", () => {
		// Regression: a token arrives, then a tool (e.g. reading a large file) runs
		// for longer than the stall threshold. The whole time, active.size > 0
		// correctly shows the tool's own status — that part was never broken.
		// The bug is the *instant after* the tool ends: falling back to the
		// streaming phase must not treat the tool's own duration as "idle", or it
		// flashes " ⚠ stalled?" right as/after a perfectly normal tool call
		// finishes — exactly what looked like a stall on a plain file read.
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 1000;
		tracker.streamToken(); // last real token at 1s
		clock = 2000;
		tracker.start("a", "read", { path: "/tmp/big.log" }); // tool starts
		clock = 22_000; // tool runs 20s — longer than the 15s stall threshold
		expect(tracker.message()).not.toMatch(/stall|⚠/i); // correct: tool status shown, not a stall
		tracker.end("a"); // tool finishes right at 22s
		expect(tracker.message()).not.toMatch(/stall|⚠/i); // must stay clean immediately after
	});

	test("a genuine stall AFTER a tool finishes is still flagged (the fix isn't a blanket suppression)", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 1000;
		tracker.start("a", "read", { path: "/tmp/big.log" });
		clock = 3000;
		tracker.end("a"); // tool finished quickly, idle clock refreshed to 3s
		clock = 20_000; // 17s of real silence since the tool finished — genuinely stalled
		expect(tracker.message()).toMatch(/stall|⚠/i);
	});
});

describe("isStalling (color ramp trigger)", () => {
	test("is false while idle", () => {
		expect(createStatusTracker().isStalling()).toBe(false);
	});

	test("flips true once a waiting phase passes the ramp trigger", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.waitStart("anthropic/claude-sonnet-4-5");
		clock = 5000; // under the 8s ramp trigger
		expect(tracker.isStalling()).toBe(false);
		clock = 12_000; // past the trigger
		expect(tracker.isStalling()).toBe(true);
	});

	test("flips true once a streaming phase sits idle past the trigger", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 5000;
		expect(tracker.isStalling()).toBe(false);
		clock = 12_000;
		expect(tracker.isStalling()).toBe(true);
	});

	test("recovers to false the instant a new token arrives (reversible)", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 20_000; // stalled
		expect(tracker.isStalling()).toBe(true);
		tracker.streamToken(); // token arrives, idle clock resets
		expect(tracker.isStalling()).toBe(false);
	});

	test("is false while a tool is running (tool status is shown, not a stall)", () => {
		let clock = 0;
		const tracker = createStatusTracker({ now: () => clock });
		tracker.streamStart();
		clock = 1000;
		tracker.start("a", "read", { path: "/tmp/big.log" });
		clock = 30_000; // tool runs long, but that's not a stall
		expect(tracker.isStalling()).toBe(false);
	});
});
