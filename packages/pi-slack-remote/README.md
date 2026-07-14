# pi-slack-remote

Drive one or many [pi](https://github.com/earendil-works/pi-coding-agent)
sessions from a Slack DM. Reply in a per-session thread to start a turn, steer
mid-stream, queue a follow-up, or abort — and get a "turn done" summary back in
that same thread.

## Why

When pi is running a long turn you often want to nudge it ("also update the
tests", "stop, wrong file") without being at the keyboard. This wires a Slack DM
to pi's steering API so your phone becomes a remote for every running session,
with each session isolated to its own Slack thread so they never cross wires.

## What it does

- On start, each session posts a root DM `🟢 [label] connected` and **owns that
  thread**.
- **Reply inside a session's thread → that session acts:**
  - idle → new turn
  - busy → **steers** the current turn (interrupt)
  - `>>…` → queued as a **follow-up**
  - `/stop` / `/abort` → abort that session's turn
  - `/status` → that session reports busy/idle in-thread
- **Bot reacts 👀** in-thread the instant a reply is picked up.
- **Turn done → summary posts in that session's thread** (last assistant
  message, trimmed).
- **Top-level DMs (not in a thread) are broadcast control only:** `/stop`
  aborts every running session. Arbitrary top-level text is ignored — reply in a
  thread to target a session.

### Thread labels

The thread label tells sessions apart at a glance:

- **Inside a [herdr](https://herdr.dev) pane** (`HERDR_ENV=1`): the herdr
  `workspace / tab` names read from the herdr socket, e.g.
  `herdr hacking / slack agent ·p1`. The `·pN` suffix disambiguates multiple
  panes in one tab, and the label refreshes on the next turn-done if you rename
  the workspace/tab.
- **Otherwise:** the pi session name (or cwd basename) + a short session id.

## Slack app setup (one time)

1. Create a Slack app at <https://api.slack.com/apps> (or reuse one).
2. **OAuth & Permissions → Bot Token Scopes**, add:
   `chat:write`, `reactions:write`, `im:write`, `im:read`, `im:history`.
3. **App Home → Show Tabs**: enable the **Messages Tab** and check
   *"Allow users to send Slash commands and messages from the messages tab"*
   (otherwise you can't DM the bot back).
4. Install / reinstall the app to your workspace and copy the **Bot User OAuth
   Token** (`xoxb-…`).

## Install

```bash
pi install /path/to/agent-tools/packages/pi-slack-remote
# or, once published:
pi install npm:pi-slack-remote
```

## Configure

Set environment variables (e.g. via your shell profile or a secrets manager):

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `SLACK_BOT_TOKEN`  | yes | — | `xoxb-…` bot token |
| `PI_SLACK_USER_ID` | yes¹ | — | your Slack user id to DM (e.g. `U012ABC…`) |
| `SLACK_USER_TOKEN` | no  | — | `xoxp-…`; if set, your user id is auto-detected |
| `PI_SLACK_POLL_MS` | no  | `3000` | poll interval (min 1000) |
| `PI_SLACK_REMOTE`  | no  | on | set `off` to start disabled |

¹ `PI_SLACK_USER_ID` is required unless `SLACK_USER_TOKEN` is provided (which is
used only to look up your own user id via `auth.test`).

## Commands (in the pi TUI)

- `/slack on` — enable + start polling (anchors a thread)
- `/slack off` — disable + stop polling
- `/slack status` — show label / channel / thread / ids
- `/slack test` — post a test message into the thread

## Notes & limits

- All sessions poll the same DM (each its own thread, plus the shared top-level
  for broadcast). A handful of sessions is fine; if you run many, raise
  `PI_SLACK_POLL_MS`. Slack `conversations.history` is Tier-3 (~50 req/min).
- No Events API / Socket Mode needed — it polls `conversations.replies` and
  `conversations.history`.
- The poll timer is `unref`'d and cleaned up on `session_shutdown`; it never
  keeps the process alive on its own.
- Nothing is logged or persisted from message contents beyond what pi already
  stores for the injected user messages.

## License

MIT. See [`LICENSE`](./LICENSE).
