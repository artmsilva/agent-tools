# Package instructions

## Scope

Pi extension that detects and repairs "poisoned" pi session `.jsonl` files caused by Anthropic API contract violations (non-text content in error `tool_result` blocks, oversized images, orphaned `tool_use_id`).

## Validation

```bash
npm test
```

## Guardrails

- Repair only rewrites `assistant`-role messages with array `content`; `sanitizeMessages`/`stripOversizedImages` silently no-op on any other shape (see the `typeof`/`role`/`Array.isArray` guards).
- `/medic` requires a real session file (`ctx.sessionManager.getSessionFile()`); ephemeral (`--no-session`) sessions cannot be repaired and must show an error, not attempt a write.
- After repair the extension writes the file but does not reload it in memory — `/reload` is a required manual follow-up step; don't assume repair takes effect immediately.
- `POISON_PATTERNS` regexes are the sole detection mechanism (`agent_end` heuristic on the last message); update this list rather than adding a parallel detection path if new Anthropic error strings are found.
- The 5MB oversized-image threshold is computed from base64 length via `(data.length * 3) / 4`, an approximation, not an exact decoded byte count.
