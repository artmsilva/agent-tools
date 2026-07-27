# Package instructions

## Scope

Pi extension that sends the last user message (or `/duet` text) to a cheap side model and shows the reply in a TUI overlay.

## Validation

```sh
npm test
```

## Guardrails

- Flat layout, no `src/`: extension entry is root `index.ts`, tests are `index.test.ts`, run by `node --test` (no glob/config needed since there's only one file).
- `runDuet` only works in `ctx.mode === "tui"`; it no-ops with an error notify otherwise — don't call it from headless/print mode.
- Prompt sent to the duet model is intentionally minimal (`cwd` + only the latest user message, no session history) — this is a deliberate design choice in `assemblePrompt`, not a bug.
- Model selection order is fixed in `resolveDuetModel` (`DUET_MODEL` env var, then `claude-haiku-4` → `claude-3-5-haiku-20241022` → `gpt-4o-mini`); changing defaults changes cost/latency tradeoffs intentionally documented in README.
- `DuetResultComponent.render` does manual ANSI-stripping word wrap (`visibleWidth`) fixed to `width = 80`; it is not a general terminal-width-aware component.
