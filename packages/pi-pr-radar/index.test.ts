import { describe, it } from "node:test";
import assert from "node:assert";
import registerPrRadar, { classifyPr, worstPr, renderSegment } from "./index.js";

describe("session lifecycle", () => {
  it("ignores a stale context from the polling timer", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const previousInterval = process.env.PR_RADAR_INTERVAL_MS;
    process.env.PR_RADAR_INTERVAL_MS = "1";

    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(event, handler),
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 1,
            title: "Open PR",
            url: "https://example.com/1",
            statusCheckRollup: { state: "SUCCESS" },
          },
        ]),
      }),
      registerShortcut: () => {},
      registerCommand: () => {},
    };

    registerPrRadar(pi as never);

    let stale = false;
    const ctx = {
      get ui() {
        if (stale) throw new Error("stale context");
        return { setStatus: () => {} };
      },
    };

    await handlers.get("session_start")?.({}, ctx);
    stale = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.get("session_shutdown")?.({}, ctx);

    if (previousInterval === undefined) delete process.env.PR_RADAR_INTERVAL_MS;
    else process.env.PR_RADAR_INTERVAL_MS = previousInterval;
  });
});

describe("classifyPr", () => {
  it("returns failing when state is FAILURE", () => {
    const rollup = { state: "FAILURE" };
    assert.strictEqual(classifyPr(rollup), "failing");
  });

  it("returns failing when state is ERROR", () => {
    const rollup = { state: "ERROR" };
    assert.strictEqual(classifyPr(rollup), "failing");
  });

  it("returns pending when state is PENDING", () => {
    const rollup = { state: "PENDING" };
    assert.strictEqual(classifyPr(rollup), "pending");
  });

  it("returns pending when state is EXPECTED", () => {
    const rollup = { state: "EXPECTED" };
    assert.strictEqual(classifyPr(rollup), "pending");
  });

  it("returns green when state is SUCCESS", () => {
    const rollup = { state: "SUCCESS" };
    assert.strictEqual(classifyPr(rollup), "green");
  });

  it("returns unknown when rollup is undefined", () => {
    assert.strictEqual(classifyPr(undefined), "unknown");
  });

  it("returns failing when any context is FAILURE", () => {
    const rollup = {
      state: "SUCCESS",
      contexts: [
        { state: "SUCCESS" },
        { state: "FAILURE" },
        { state: "SUCCESS" },
      ],
    };
    assert.strictEqual(classifyPr(rollup), "failing");
  });

  it("returns pending when any context is PENDING and none failing", () => {
    const rollup = {
      state: "SUCCESS",
      contexts: [{ state: "SUCCESS" }, { state: "PENDING" }],
    };
    assert.strictEqual(classifyPr(rollup), "pending");
  });

  it("returns green when all contexts are SUCCESS", () => {
    const rollup = {
      state: "EXPECTED",
      contexts: [
        { state: "SUCCESS" },
        { state: "SUCCESS" },
        { state: "SUCCESS" },
      ],
    };
    assert.strictEqual(classifyPr(rollup), "green");
  });

  it("returns unknown for unrecognized state", () => {
    const rollup = { state: "UNKNOWN_STATE" };
    assert.strictEqual(classifyPr(rollup), "unknown");
  });

  it("handles case-insensitive states", () => {
    assert.strictEqual(classifyPr({ state: "failure" }), "failing");
    assert.strictEqual(classifyPr({ state: "pending" }), "pending");
    assert.strictEqual(classifyPr({ state: "success" }), "green");
  });
});

describe("worstPr", () => {
  it("returns failing PR first", () => {
    const prs = [
      { number: 1, title: "Green PR", url: "url1", state: "green" as const },
      {
        number: 2,
        title: "Failing PR",
        url: "url2",
        state: "failing" as const,
      },
      { number: 3, title: "Pending PR", url: "url3", state: "pending" as const },
    ];
    const worst = worstPr(prs);
    assert.strictEqual(worst?.number, 2);
    assert.strictEqual(worst?.state, "failing");
  });

  it("returns pending PR when no failing", () => {
    const prs = [
      { number: 1, title: "Green PR", url: "url1", state: "green" as const },
      { number: 2, title: "Pending PR", url: "url2", state: "pending" as const },
    ];
    const worst = worstPr(prs);
    assert.strictEqual(worst?.number, 2);
    assert.strictEqual(worst?.state, "pending");
  });

  it("returns green PR when all green", () => {
    const prs = [
      { number: 1, title: "Green PR 1", url: "url1", state: "green" as const },
      { number: 2, title: "Green PR 2", url: "url2", state: "green" as const },
    ];
    const worst = worstPr(prs);
    assert.strictEqual(worst?.number, 1);
    assert.strictEqual(worst?.state, "green");
  });

  it("returns first PR when all unknown", () => {
    const prs = [
      {
        number: 1,
        title: "Unknown PR 1",
        url: "url1",
        state: "unknown" as const,
      },
      {
        number: 2,
        title: "Unknown PR 2",
        url: "url2",
        state: "unknown" as const,
      },
    ];
    const worst = worstPr(prs);
    assert.strictEqual(worst?.number, 1);
  });

  it("returns undefined for empty array", () => {
    const worst = worstPr([]);
    assert.strictEqual(worst, undefined);
  });

  it("prefers first failing when multiple", () => {
    const prs = [
      {
        number: 1,
        title: "Failing PR 1",
        url: "url1",
        state: "failing" as const,
      },
      {
        number: 2,
        title: "Failing PR 2",
        url: "url2",
        state: "failing" as const,
      },
    ];
    const worst = worstPr(prs);
    assert.strictEqual(worst?.number, 1);
  });
});

describe("renderSegment", () => {
  it("renders all three counts", () => {
    const segment = renderSegment({ failing: 2, pending: 1, green: 3 });
    assert.strictEqual(segment, "PR ✗2 ●1 ✓3");
  });

  it("omits zero counts", () => {
    const segment = renderSegment({ failing: 0, pending: 1, green: 0 });
    assert.strictEqual(segment, "PR ●1");
  });

  it("renders only failing", () => {
    const segment = renderSegment({ failing: 5, pending: 0, green: 0 });
    assert.strictEqual(segment, "PR ✗5");
  });

  it("renders only green", () => {
    const segment = renderSegment({ failing: 0, pending: 0, green: 7 });
    assert.strictEqual(segment, "PR ✓7");
  });

  it("handles all zeros", () => {
    const segment = renderSegment({ failing: 0, pending: 0, green: 0 });
    assert.strictEqual(segment, "PR ");
  });

  it("renders in correct order: failing, pending, green", () => {
    const segment = renderSegment({ failing: 1, pending: 2, green: 3 });
    assert.strictEqual(segment, "PR ✗1 ●2 ✓3");
  });
});
