# pi-extensions

Personal grab-bag of small [pi](https://github.com/earendil-works/pi) extensions, moved here
from `~/.pi/agent/extensions/` so they're versioned.

| extension | what it does |
|---|---|
| `sanitize-error-results.ts` | Strips non-text blocks from `isError` tool results — Anthropic rejects `is_error: true` with image content, and the poisoned message otherwise bricks the session permanently (same class as pi#2055). Remove once fixed upstream. |
| `dcg-guard.ts` | Blocks destructive shell tool calls via [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard). |
| `open-zed.ts` | `/zed` or `alt+z` opens the most recently used worktree in a new Zed window; its `⌥Z` footer item (with pi-footer) shows the target. It updates after successful `read`, `edit`, `write`, or leading `cd` shell commands and survives `/reload`. |
| `open-hunk.ts` | `/hunk` or `alt+h` reviews the current worktree's diff in [hunk](https://github.com/modem-dev/hunk) (`hunk diff --watch`), opened in a new detached Ghostty window since hunk is a terminal UI and can't share pi's own terminal. Its `⌥H` footer item (with pi-footer) shows the target worktree. |
| `worktree.ts` | `create_worktree` tool + `/worktree` command — isolated git worktrees with node_modules pre-linked (symlink/CoW/copy). |

## Install

```bash
pi install /path/to/agent-tools/packages/pi-extensions
```

Not published to npm (`private: true`); path install only.

Note: `herdr-agent-state.ts` intentionally stays in `~/.pi/agent/extensions/` — it is
herdr-managed and gets overwritten on herdr updates.
