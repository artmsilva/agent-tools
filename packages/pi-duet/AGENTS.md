# Package instructions

## Scope

Pi extension for isolated side conversations: `/duet` sends one prompt to a cheap model; `/btw` asks the active model about the current session without tools or transcript writes.

## Validation

```sh
npm test
```

## Guardrails

- Flat layout, no `src/`: extension entry is root `index.ts`, tests are `index.test.ts`, run by `node --test` (no glob/config needed since there's only one file).
- `runDuet` only works in `ctx.mode === "tui"`; it no-ops with an error notify otherwise — don't call it from headless/print mode.
- `/duet` context is intentionally minimal (`cwd` + one user message). `/btw` does the opposite: it replays the current complete session prefix, then appends one tool-free question.
- `/btw` must reject provider-invalid context between a tool call and its result. It must never append its question or answer to the main session.
- Model selection order is fixed in `resolveDuetModel` (`DUET_MODEL` env var, then `claude-haiku-4` → `claude-3-5-haiku-20241022` → `gpt-4o-mini`); changing defaults changes cost/latency tradeoffs intentionally documented in README.
- `DuetResultComponent.render` does manual ANSI-stripping word wrap (`visibleWidth`) fixed to `width = 80`; it is not a general terminal-width-aware component.
