# agent-tools

Small open-source tools for AI-agent workflows.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `pi-ask-user` | [`packages/pi-ask-user`](./packages/pi-ask-user) | Pi `ask_user` tool + decision-gating skill |
| `pi-claude-bridge` | [`packages/pi-claude-bridge`](./packages/pi-claude-bridge) | Bridge Claude Code content into Pi: user-scope + project `.claude` commands/skills/agents, installed Claude plugins, and Claude hooks — so new Claude plugins appear in Pi with zero manual wiring |
| `pi-gondolin` | [`packages/pi-gondolin`](./packages/pi-gondolin) | Run Pi's tools in a Gondolin micro-VM: locked-egress allowlist with interactive approval, read-only skills, your zsh/dotfiles, git-worktree safety, opt-in browser |
| `pi-slack-remote` | [`packages/pi-slack-remote`](./packages/pi-slack-remote) | Drive one or many Pi sessions from a Slack DM: reply in a per-session thread to start turns, steer mid-stream, queue follow-ups, or abort, and get a turn-done summary back — with herdr workspace/tab thread labels |
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
