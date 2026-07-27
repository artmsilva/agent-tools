# Package instructions

## Scope

Pi extension: replaces the opaque `Working...` line with a live, phase-aware,
stall-ramping status driven by a 500ms tick independent of model/tool events.

## Validation

```bash
npm run check
```

## Guardrails

- `status.ts` must stay pure and unit-tested (`status.test.ts`, `bun test`);
  `index.ts` only renders — don't move stall/elapsed logic back into `index.ts`.
- The stall color ramp and elapsed counter advance only on the fixed 500ms
  tick, never on the wall clock or per-event — this is what makes a clock
  jump (sleep/NTP step) unable to flash the ramp to full red.
- Single working-message owner: don't run another extension that also calls
  `ctx.ui.setWorkingMessage` — last-write-wins races the two.
- Render must never throw on a stale `ctx` (session switch/fork/reload) —
  catch and drop `lastCtx`, let the next event supply a fresh one.
- Sad-path hardening (missing/hostile tool args, ANSI stripping, clock skew
  clamped to 0s, unknown `toolCallId`) lives in `status.ts` — preserve it when
  touching tool-arg formatting.
