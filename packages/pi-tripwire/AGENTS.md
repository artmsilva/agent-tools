# Package instructions

## Scope

Pi extension: `tool_result` hook that redacts secrets (GitHub/Slack/AWS/OpenAI/
Anthropic/JWT/PEM/Bearer/npm) from outbound tool results via the pure `redact()`.

## Validation

```bash
npm test
```

## Guardrails

- `redact()` must stay pure and exported — it's unit-tested directly in
  `index.test.ts`, independent of the `tool_result` hook wiring.
- Never redact `op://` references (1Password pointers); they're extracted and
  restored around the pattern passes, not matched by any `PATTERNS` regex.
- Only `text` content blocks are scanned; `image` blocks must pass through
  untouched.
- Zero runtime dependencies — pure TypeScript, precompiled regexes only.
