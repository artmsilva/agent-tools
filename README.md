# agent-tools

Small open-source tools for AI-agent workflows.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `pi-agent-browser` | [`packages/pi-agent-browser`](./packages/pi-agent-browser) | Lean single-file `agent_browser` tool wrapping the agent-browser CLI: TOON-encoded output (~40–60 % fewer tokens), screenshots as image attachments, session-poisoning bug fixed by construction |
| `pi-ask-user` | [`packages/pi-ask-user`](./packages/pi-ask-user) | Pi `ask_user` tool + decision-gating skill |
| `pi-blackbox` | [`packages/pi-blackbox`](./packages/pi-blackbox) | Flight recorder: logs every tool execution (timing, errors, arg/result summaries) to SQLite, with a `/blackbox` timeline command |
| `pi-claude-bridge` | [`packages/pi-claude-bridge`](./packages/pi-claude-bridge) | Bridge Claude Code content into Pi: user-scope + project `.claude` commands/skills/agents, installed Claude plugins, and Claude hooks — so new Claude plugins appear in Pi with zero manual wiring |
| `pi-duet` | [`packages/pi-duet`](./packages/pi-duet) | Instant second opinion: `alt+u` or `/duet` sends a prompt to a cheap second model in the background and shows the answer in a side overlay |
| `pi-extensions` | [`packages/pi-extensions`](./packages/pi-extensions) | Grab-bag of small extensions: `dcg-guard` (destructive-command blocking), `worktree` (isolated worktrees with node_modules pre-linked), `open-zed`, `sanitize-error-results` (path install only, not on npm) |
| `pi-gondolin` | [`packages/pi-gondolin`](./packages/pi-gondolin) | Run Pi's tools in a Gondolin micro-VM: locked-egress allowlist with interactive approval, read-only skills, your zsh/dotfiles, git-worktree safety, opt-in browser |
| `pi-pr-radar` | [`packages/pi-pr-radar`](./packages/pi-pr-radar) | Ambient PR awareness: polls your open PRs, footer status with failing/pending/green counts, `alt+p` opens the worst PR, `/prs` lists all |
| `pi-session-medic` | [`packages/pi-session-medic`](./packages/pi-session-medic) | Detects and repairs poisoned sessions (Anthropic `is_error` + non-text content 400 loops, oversized images, orphaned `tool_use_id`) via a `/medic` command |
| `pi-slack-remote` | [`packages/pi-slack-remote`](./packages/pi-slack-remote) | Drive one or many Pi sessions from a Slack DM: reply in a per-session thread to start turns, steer mid-stream, queue follow-ups, or abort, and get a turn-done summary back — with herdr workspace/tab thread labels |
| `pi-tripwire` | [`packages/pi-tripwire`](./packages/pi-tripwire) | Redacts secrets from tool results before they enter model context, replacing them with `[TRIPWIRE:<type>]` markers |
| `pi-vibes` | [`packages/pi-vibes`](./packages/pi-vibes) | Ambient vibes: soundtrack (system sounds on tool events), mood ring (session-health dot in footer), and familiar |
| `pi-working-message` | [`packages/pi-working-message`](./packages/pi-working-message) | Replaces Pi's opaque `Working...` line with a live, phase-aware status: waiting for the model, streaming tokens, or running a specific tool, each with elapsed time and a stall warning |

Install the Pi package:

```sh
pi install npm:pi-ask-user
```

## Herdr plugins

| Plugin | Path | Install |
| --- | --- | --- |
| Active File, Browser & Diff Preview | [`plugins/herdr/file-view`](./plugins/herdr/file-view) | `herdr plugin install artmsilva/agent-tools/plugins/herdr/file-view --yes` |
| Command Palette | [`plugins/herdr/command-palette`](./plugins/herdr/command-palette) | `herdr plugin install artmsilva/agent-tools/plugins/herdr/command-palette --yes` |

Reload Herdr after installing:

```sh
herdr server reload-config
```

### Command palette shortcut

Bind the command palette action in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+k"
type = "plugin_action"
command = "io.github.artmsilva.command-palette.open"
description = "open command palette"
```

Ghostty can map `⌘K` to that Herdr prefix chord:

```conf
keybind = super+k=text:\x02K
```

## License

MIT. See [`LICENSE`](./LICENSE).
