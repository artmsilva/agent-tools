# pi-live-status

Replaces pi's opaque `⋮ Working...` line with a live readout of what the agent is
actually doing, plus a verbose streaming activity feed below the editor.

## Why

`Working...` tells you nothing: not how long it's been running, not whether the
model is thinking or a tool is grinding, not whether anything is stuck. This
extension makes the run observable so you can actively debug it.

## What you see

Working line (always, in `line` and `verbose` modes):

```
⠋ bash · npm install @tintinweb/pi-subagents · 42s
⠋ thinking · 8s · ~1.2k tok
⠋ 2 tools · bash, read · 12s
```

Activity feed widget below the editor (`verbose` mode):

```
· turn 2 started
▶ bash  npm install @tintinweb/pi-subagents
│ added 4 packages in 5s                      <- live tail of streaming output
✓ bash  5.1s
⏵ read · src/index.ts · 2s
── live-status · turn 2 · 48s · 3 tools done · ~3.4k tok
```

- **Elapsed everywhere** — the #1 "is it stuck?" signal
- **Live output tail** — last line of each running tool's streaming output
- **Stall flag** — any tool running > 30s turns red with a `Ctrl+O expand / Esc abort` hint
- **Run summary** — after the run settles, the footer status shows
  `last run 1m32s · 4 turns · 12 tools · ~8k tok`

## Modes

| Mode | Working line | Feed widget |
|---|---|---|
| `verbose` (default) | ✓ | ✓ |
| `line` | ✓ | — |
| `off` | pi default | — |

`/live-status` cycles modes; `/live-status verbose|line|off` sets one directly.

## Install

```bash
pi install /path/to/agent-tools/packages/pi-live-status
```

Or try it for one run:

```bash
pi -e /path/to/agent-tools/packages/pi-live-status/index.ts
```

## Notes

- Pure observer: no tool blocking, no message mutation, no model calls.
- Zero runtime dependencies; single file; loads as `.ts` via jiti.
- Streaming-event field probing is defensive (`type`/`delta`/`text`), so unknown
  provider event shapes degrade gracefully instead of breaking.
- Ticker (500ms) only runs while the agent is active and UI is present; cleaned
  up on `agent_settled` and `session_shutdown`.

## License

MIT
