# pi-working-message

Replaces pi's opaque `Working...` line with a live, phase-aware status, so a
long-running turn is legible instead of a black box.

## Why

`Working...` tells you nothing: not whether the model has responded yet, not
whether tokens are actually streaming, not whether a tool is just slow or the
whole thing is stuck. This extension makes that observable.

## What you see

| Phase | Example |
|---|---|
| Model call sent, no tokens yet | `Waiting for anthropic/claude-sonnet-4-5… (4s)` |
| Tokens streaming in | `Streaming response… (12s)` |
| Tool running | `Reading src/foo.ts (3s)` / `Running: npm test (47s)` |
| Parallel tools | `Editing bar.ts (2s) (+2 more)` |

- **Elapsed everywhere** — ticks live every 500ms, even with zero events from
  pi, which is the actual signal for a real stall vs. "slow but alive".
- **Stall warning** — a phase idle past ~15s (no first token, or no new token
  mid-stream) gets a ` ⚠ stalled?` suffix so you know it's safe to Ctrl-C.
- **Animated spinner** alongside the status text.

## Install

```bash
pi install /path/to/agent-tools/packages/pi-working-message
```

Or try it for one run:

```bash
pi -e /path/to/agent-tools/packages/pi-working-message/index.ts
```

## Sad-path hardening

Status formatting lives in `status.ts` (pure, unit-tested in `status.test.ts`
via `bun test`) and is hardened against:

- missing/non-string/empty tool args → clean fallback labels, never the
  literal string `"undefined"`
- ANSI escapes / control chars in tool args (e.g. injected via a bash command
  or a path) → stripped before rendering
- long/multiline commands → truncated to a single bounded-length line
- hostile args (throwing getters/Proxies from a misbehaving MCP tool) →
  caught, never crashes the loader
- unknown `toolCallId` on end → no-op, doesn't corrupt other in-flight state
- stuck/dropped tool-execution events → `reset()` recovers to idle
- clock skew (negative elapsed) → clamped to `0s`, no `NaN`/`Infinity` leaks

## Notes

- Pure observer: no tool blocking, no message mutation, no model calls.
- Single working-message owner: don't run this alongside another extension
  that also calls `ctx.ui.setWorkingMessage` on its own ticker (e.g.
  `pi-live-status`) — last-write-wins races and mismatched line lengths will
  fight each other.
- Ticker (500ms) is created on `session_start` and cleared on
  `session_shutdown`.

## License

MIT
