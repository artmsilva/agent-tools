# Package instructions

## Scope

Pi extension: ambient soundtrack, mood ring, and familiar footer status driven
off a shared rolling window of tool events.

## Validation

```bash
npm test
```

## Guardrails

- Mood and familiar share one footer status key (`ctx.ui.setStatus("vibes",
  ...)`) — pi's footer shows all status keys together, so don't split them.
- Sound spawns must stay `{ detached: true, stdio: "ignore" }` + `.unref()`,
  and the animation timer must stay `setInterval(...).unref()` — neither may
  keep the process alive.
- `updateLastStatus()` swallows a stale-`ctx` throw and drops `lastCtx` rather
  than rethrowing — a queued timer can outlive its session on reload.
- Settings persist in `~/.pi/agent/vibes.json`; changing the shape needs a
  migration path in `settings.ts`, not a silent break.
- Debounce sound to max 1 per 2 seconds — don't remove this without checking
  `soundtrack.ts`.
