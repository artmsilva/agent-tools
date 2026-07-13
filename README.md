# agent-tools

Small open-source tools for AI-agent workflows.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `pi-ask-user` | [`packages/pi-ask-user`](./packages/pi-ask-user) | Pi `ask_user` tool + decision-gating skill |
| `pi-gondolin` | [`packages/pi-gondolin`](./packages/pi-gondolin) | Run Pi's tools in a Gondolin micro-VM: locked-egress allowlist with interactive approval, read-only skills, your zsh/dotfiles, git-worktree safety, opt-in browser |
| `pi-live-status` | [`packages/pi-live-status`](./packages/pi-live-status) | Verbose live "Working..." replacement: phase, current tool, elapsed, token flow, streaming activity feed |

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
