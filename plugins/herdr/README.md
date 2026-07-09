# Herdr plugins

This repo also ships small [Herdr](https://herdr.dev) plugins.

## Plugins

| Plugin | ID | Install |
| --- | --- | --- |
| Active File, Browser & Diff Preview | `io.github.artmsilva.file-view` | `herdr plugin install artmsilva/agent-tools/plugins/herdr/file-view --yes` |
| Command Palette | `io.github.artmsilva.command-palette` | `herdr plugin install artmsilva/agent-tools/plugins/herdr/command-palette --yes` |

Reload Herdr after installing:

```sh
herdr server reload-config
```

## Command palette shortcut

The command palette action is `io.github.artmsilva.command-palette.open`.
Bind it in `~/.config/herdr/config.toml`:

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
