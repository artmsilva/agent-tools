# pi-extensions

Personal grab-bag of small [pi](https://github.com/earendil-works/pi) extensions, moved here
from `~/.pi/agent/extensions/` so they're versioned.

| extension | what it does |
|---|---|
| `sanitize-error-results.ts` | Strips non-text blocks from `isError` tool results — Anthropic rejects `is_error: true` with image content, and the poisoned message otherwise bricks the session permanently (same class as pi#2055). Remove once fixed upstream. |
| `dcg-guard.ts` | Blocks destructive shell tool calls via [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard). |
| `open-zed.ts` | `alt+z` opens the current worktree in Zed. |
| `worktree.ts` | `create_worktree` tool + `/worktree` command — isolated git worktrees with node_modules pre-linked (symlink/CoW/copy). |

## Install

```bash
pi install /path/to/agent-tools/packages/pi-extensions
```

Not published to npm (`private: true`); path install only.

Note: `herdr-agent-state.ts` intentionally stays in `~/.pi/agent/extensions/` — it is
herdr-managed and gets overwritten on herdr updates.
