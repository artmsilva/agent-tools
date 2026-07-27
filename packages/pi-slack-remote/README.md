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
- Remote-enabled turns get a hidden reminder that Slack recommends messages
  under 4,000 characters and truncates `chat.postMessage` text above 40,000.
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
  This fallback also applies whenever herdr detection fails partway — e.g.
  `HERDR_ENV=1` without `HERDR_SOCKET_PATH`, or a socket call that times out
  (800ms) or returns no workspace/tab label.

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
| `PI_SLACK_REMOTE`  | no  | off | set `on` to start enabled |

¹ `PI_SLACK_USER_ID` is required unless `SLACK_USER_TOKEN` is provided (which is
used only to look up your own user id via `auth.test`). If `PI_SLACK_USER_ID` is
set, `SLACK_USER_TOKEN` is never consulted for identity — it's a fallback, not an
override. If neither resolves an id, the extension logs a status and stays
disabled rather than throwing.

## Commands (in the pi TUI)

- `/slack on` — enable + start polling (anchors a thread)
- `/slack off` — disable + stop polling
- `/slack status` — show label / channel / thread / ids
- `/slack test` — post a test message into the thread

## Notes & limits

- All sessions poll the same DM (each its own thread, plus the shared top-level
  for broadcast). A handful of sessions is fine; if you run many, raise
  `PI_SLACK_POLL_MS`. Slack `conversations.history` is Tier-3 (~50 req/min).
- Slack recommends `chat.postMessage` `text` stay under 4,000 characters and
  truncates messages above 40,000. The extension tells pi this before remote
  turns and locally clips any outbound Slack post at 40,000 characters before
  Slack can silently truncate it. Turn-done summaries are additionally
  pre-trimmed to ~1,500 characters (a separate, tighter limit than the 40,000
  hard clip) before that clip is even applied.
- No Events API / Socket Mode needed — it polls `conversations.replies` and
  `conversations.history`.
- The poll timer is `unref`'d and cleaned up on `session_shutdown`; it never
  keeps the process alive on its own.
- Nothing is logged or persisted from message contents beyond what pi already
  stores for the injected user messages.

## License

MIT. See [`LICENSE`](./LICENSE).
