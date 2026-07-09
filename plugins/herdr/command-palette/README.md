# Herdr Command Palette

A small Herdr plugin that opens a fzf-style quick action palette.

## Install

```sh
herdr plugin install artmsilva/agent-tools/plugins/herdr/command-palette --yes
herdr server reload-config
```

## Use

- Bind the action `io.github.artmsilva.command-palette.open` in Herdr config.
- Recommended Herdr binding:
  ```toml
  [[keys.command]]
  key = "prefix+shift+k"
  type = "plugin_action"
  command = "io.github.artmsilva.command-palette.open"
  description = "open command palette"
  ```
- Ghostty `⌘K` passthrough mapping:
  ```conf
  keybind = super+k=text:\x02K
  ```
- Manual fallback:
  ```sh
  herdr plugin action invoke io.github.artmsilva.command-palette.open
  ```

If `fzf` is installed, the overlay is fuzzy-searchable. Without `fzf`, it falls
back to a numbered menu.

## Included actions

Includes plugin shortcuts plus the standard Herdr keybind action set where a CLI
or safe equivalent exists:

- App/prefix actions: reload config plus reminders for help/settings/goto/etc.
- Workspaces/worktrees: create, rename, close, previous/next, picker, worktree create/open/remove
- Tabs: new, rename, previous/next, picker, close
- Panes: rename/clear, read scrollback, focus, cycle, swap, split, close, zoom, resize
- Agents: previous/next/picker
- Shell tools: lazygit, git status, Hunk diff in focused cwd
