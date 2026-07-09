# Active File & Browser Preview — a Herdr plugin

Three side panes for a [Herdr](https://herdr.dev) workspace:

1. **Active File** — a live, syntax-highlighted preview of the file your coding
   agent (Claude Code or pi) is currently editing. Re-renders as the agent
   switches files or edits the tracked one.
2. **Current Diff** — a live [Hunk](https://www.hunk.dev/) review pane for the
   focused agent/workspace Git checkout. Runs `hunk diff --watch` so the diff
   refreshes as the agent edits.
3. **Agent Browser** *(optional)* — a **watch-only** frame preview of an
   [agent-browser](https://agent-browser.dev) session, decoded from its
   WebSocket stream and blitted with the terminal graphics protocol.

There is no plugin SDK — the whole Herdr CLI is the API. Everything here shells
back into Herdr via `$HERDR_BIN_PATH`.

## Requirements

- Herdr `>= 0.7.0`
- **Active File pane:** [`bat`](https://github.com/sharkdp/bat) recommended
  (falls back to `cat`). POSIX `sh` only.
- **Current Diff pane:** [`hunk`](https://www.hunk.dev/) (`brew install hunk` or
  `npm i -g hunkdiff`) and Git.
- **Agent Browser pane:** Node `>= 21` (uses the built-in global `WebSocket`;
  no npm dependencies) and an image renderer. The pane auto-selects:
  - **Crisp (true graphics):** enable Herdr's experimental Kitty-graphics
    passthrough — add to `~/.config/herdr/config.toml`:
    ```toml
    [experimental]
    kitty_graphics = true
    ```
    then `herdr server reload-config` (a full restart may be needed). With it
    on, the pane renders pixel-accurate frames via `kitten icat`/`icat`, or
    macOS `sips` (no extra install). By default Herdr's grid **drops** the
    Kitty protocol, so without this flag graphics show nothing — hence:
  - **Portable fallback:** [`chafa`](https://hpjansson.org/chafa/)
    (`brew install chafa`) renders frames as truecolor Unicode blocks (blocky
    but works in any grid, flag or not).

  Selection: if `kitty_graphics = true` and a graphics helper exists → true
  graphics; otherwise → chafa. Force with
  `HERDR_FILE_VIEW_RENDER=chafa|kitten|native`.

## Install

From GitHub:

```sh
herdr plugin install artmsilva/agent-tools/plugins/herdr/file-view --yes
herdr server reload-config
```

For local development:

```sh
herdr plugin link /ABSOLUTE/PATH/TO/agent-tools/plugins/herdr/file-view
```

`plugin link` reads `herdr-plugin.toml` from this directory. Use the same
absolute path when wiring the Claude Code hook below.

To remove: `herdr plugin unlink io.github.artmsilva.file-view`.

---

## Feature 1 — Active file preview

### 1. Track the file your agent edits

**Claude Code (hook).** Add a `PostToolUse` hook to your Claude Code
`settings.json` (see [`hooks/claude-code-settings.example.json`](hooks/claude-code-settings.example.json)).
Point `command` at the shipped hook script by its absolute path. For a GitHub
install, use the managed plugin path shown by `herdr plugin list`; for local
development use this checkout path:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "/ABSOLUTE/PATH/TO/herder-browser-file-view/hooks/claude-code-active-file.sh"
          }
        ]
      }
    ]
  }
}
```

The hook reads Claude Code's payload on stdin, pulls `tool_input.file_path`,
resolves it to an absolute path, and appends it to the state file the pane
tails. It uses `jq` if present, otherwise `node`.

**pi.** pi's hook support is not verified here — if your pi build exposes a
post-edit / post-tool hook, point it at the same
`hooks/claude-code-active-file.sh` (it only needs `tool_input.file_path` and
`cwd` on stdin as JSON). Otherwise use the fallback watcher:

**Fallback watcher (any agent).** Tracks the most-recently-modified file under a
directory (default: cwd). Uses `fswatch` if installed, otherwise polls:

```sh
sh /ABSOLUTE/PATH/TO/herder-browser-file-view/bin/mru-watch.sh [dir]
```

### 2. Open the pane

Bound to **`prefix f`**, or:

```sh
herdr plugin action invoke io.github.artmsilva.file-view.open-file
```

which opens the pane as a right-hand split. Equivalent direct form:

```sh
herdr plugin pane open --plugin io.github.artmsilva.file-view \
  --entrypoint file --placement split --direction right
```

The pane shows a "waiting" screen until the first edit lands, then renders the
tracked file and re-renders when the path changes or the file is edited again.

---

## Feature 2 — Current diff preview

Bound to **`prefix d`**, or:

```sh
herdr plugin action invoke io.github.artmsilva.file-view.open-hunk
```

The action reads Herdr's invocation context, prefers the focused pane's cwd,
falls back to Herdr worktree/workspace metadata, opens a right split at the Git
root, and runs:

```sh
hunk diff --watch
```

Hunk includes untracked files in this mode and auto-reloads as the agent edits.

---

## Feature 3 — Agent-browser frame preview *(optional)*

Watch-only. This pane **never sends input** to the browser — it only displays
frames.

### 1. Launch agent-browser with a fixed stream port

agent-browser picks an OS-assigned port by default, so set one explicitly:

```sh
AGENT_BROWSER_STREAM_PORT=9223 agent-browser ...
```

The pane reads `$AGENT_BROWSER_STREAM_PORT` and connects to
`ws://localhost:<port>`.

### 2. Open the pane

Bound to **`prefix b`**, or:

```sh
herdr plugin action invoke io.github.artmsilva.file-view.open-browser
```

If no port is set, no graphics helper is found, or the stream isn't reachable,
the pane prints a short explanation and **exits 0** — it never crashes the
workspace.

---

## How it works

```
Claude Code edit ──PostToolUse hook──┐
                                     ▼
                         $HERDR_PLUGIN_STATE_DIR/active-file   (append path)
                                     ▲                    │ tail -n1
   fallback: bin/mru-watch.sh ───────┘                    ▼
                                              panes/file.sh ── bat/cat ── pane

agent-browser ──ws://127.0.0.1:<port>── {"type":"frame","data":<base64 jpeg>}
   (port auto-discovered from `agent-browser stream status`)  │
                          panes/browser.js ── base64→JPEG ── chafa ── pane
```

**Bridging the state dir.** Herdr injects `$HERDR_PLUGIN_STATE_DIR` into
pane/action commands, but the Claude Code hook runs in Claude Code's own
process and doesn't get it. So the pane writes a *discovery pointer* at a fixed
XDG path (`${XDG_STATE_HOME:-~/.local/state}/herdr-file-view/state-dir-pointer`)
holding the real state-file path. The hook resolves its target in this order
(see [`lib/paths.sh`](lib/paths.sh)):

1. `$HERDR_FILE_VIEW_ACTIVE` — explicit override
2. `$HERDR_PLUGIN_STATE_DIR/active-file` — when run by Herdr
3. the discovery pointer — after the pane has run once
4. XDG fallback — before the pane has ever run

The state file itself lives at `$HERDR_PLUGIN_STATE_DIR/active-file`, per the
Herdr runtime-state contract. Nothing durable is written into
`$HERDR_PLUGIN_ROOT` (it's a managed git checkout on GitHub installs).

## Layout

```
herdr-plugin.toml                 manifest: id/name/version, actions, panes
panes/file.sh                     active-file preview (POSIX sh, bat/cat)
panes/hunk.sh                     current-diff preview (Hunk watch mode)
panes/browser.js                  agent-browser frame preview (Node, kitten icat)
actions/open-file.sh              opens the file pane as a right split
actions/open-hunk.sh              opens the Hunk diff pane as a right split
actions/open-browser.sh           opens the browser pane as a right split
hooks/claude-code-active-file.sh  Claude Code PostToolUse hook
hooks/claude-code-settings.example.json
bin/mru-watch.sh                  fallback most-recently-modified-file watcher
lib/paths.sh                      shared state-file path resolution
```

## Publishing (later)

Not published yet. To make it marketplace-discoverable, push to GitHub and add
the repository topic **`herdr-plugin`**.
