# Package instructions

## Scope
Pi extension recording every tool execution to a local SQLite ring-buffer database (`~/.pi/agent/blackbox.db`) and exposing a `/blackbox` timeline command.

## Validation
- `npm test` (runs `node --test`)

## Guardrails
- All DB operations (`openDB`, `insertExecution`, `pruneOldRows`) must fail soft — swallow errors and never throw, so a broken or locked DB can't crash a session.
- The row count is capped at `MAX_ROWS` (20,000); `pruneOldRows` deletes the oldest rows past that cap on every insert — don't remove pruning or the DB grows unbounded.
- Only the first 200 chars of tool result text and stringified args are persisted (`summarizeContent`/`summarizeArgs`); don't widen this without checking the privacy note in README.
- `tool_execution_end` looks up its matching `tool_execution_start` via the in-memory `pending` map keyed by `toolCallId`; if no match is found the event is silently dropped.
- The package is `"private": true` in package.json — it is not meant to be published to npm.
