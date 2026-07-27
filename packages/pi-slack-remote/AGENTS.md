# Package instructions

## Scope

Pi extension that drives one or many pi sessions from a Slack DM, one thread per session, supporting steer/follow-up/abort/status control and turn-done summaries.

## Validation

```bash
npm run check
npm test
```

## Guardrails

- `PI_SLACK_USER_ID` takes precedence when set; `SLACK_USER_TOKEN` is only used to auto-detect the user id via `auth.test` when `PI_SLACK_USER_ID` is unset — see `resolveIdentity`. Neither present → extension stays disabled (status message), it does not throw.
- Herdr labeling requires both `HERDR_ENV=1` and `HERDR_SOCKET_PATH`; the herdr socket call has an 800ms timeout and any failure/timeout/missing label falls back to session name → `basename(cwd)` → `"pi"` (`computeLabel`). Don't assume `HERDR_ENV=1` alone is sufficient.
- Outbound Slack posts are clipped twice at different points: `fitSlackText` hard-clips any `post()` body at `SLACK_HARD_TEXT_CHARS` (40,000), while turn-done summaries are separately pre-trimmed to `MAX_NOTIFY_CHARS` (1,500) before that. Don't conflate the two limits when changing truncation behavior.
- Top-level (non-threaded) DMs are broadcast-only and only react to `/stop`/`/abort`; arbitrary top-level text must stay ignored — only in-thread replies drive a session.
- The poll timer is `unref()`'d and stopped in `stop()`/`session_shutdown`; preserve both when touching `start`/`stop`.
- Only messages from `myUserId` with no `bot_id`/`subtype` are treated as commands (`poll`'s filters) — this excludes the bot's own posts and Slack system messages from being replayed as input.
