# pi-ask-user

A Pi package that adds an interactive `ask_user` tool for collecting user decisions during an agent run.

## Demo

![ask_user demo](./media/ask-user-demo.gif)

High-quality video: [ask-user-demo.mp4](./media/ask-user-demo.mp4)

## Features

- Searchable single-select option lists with wrapped titles and descriptions
- Responsive split-pane details preview on wide terminals with single-column fallback on narrow terminals
- Multi-select option lists
- Optional freeform responses
- User-toggleable extra context on structured selections
- Context display support
- Configurable display mode: `overlay` (modal, default) or `inline` (rendered directly in the flow)
- Runtime overlay toggle: press the configured overlay-toggle key (`alt+o` by default, configurable per call or via env var) while the prompt is open to temporarily hide/show the popup so you can read prior agent output, then press it again to bring it back
- Pi-TUI-aligned keybinding and editor behavior
- Custom TUI rendering for tool calls and results
- System prompt integration via `promptSnippet` and `promptGuidelines`
- Optional timeout for auto-dismiss in both overlay and fallback input modes
- Structured `details` on all results for session state reconstruction
- Graceful fallback when interactive UI is unavailable
- Bundled `ask-user` skill for mandatory decision-gating in high-stakes or ambiguous tasks

## Bundled skill: `ask-user`

This package now ships a skill at `skills/ask-user/SKILL.md` that nudges/mandates the agent to use `ask_user` when:

- architectural trade-offs are high impact
- requirements are ambiguous or conflicting
- assumptions would materially change implementation

The skill follows a "decision handshake" flow:

1. Gather evidence and summarize context
2. Ask one focused question via `ask_user`
3. Wait for explicit user choice
4. Confirm the decision, then proceed

See: `skills/ask-user/references/ask-user-skill-extension-spec.md`.

## Install

```bash
pi install npm:pi-ask-user
```

## Tool name

The registered tool name is:

- `ask_user`

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | *required* | The question to ask the user |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string \| {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a "Type something" freeform option |
| `allowComment` | `boolean?` | `false` | Expose a user-toggleable extra-context option in the custom UI (`ctrl+g` or the toggle row) and collect an optional comment in fallback dialogs |
| `displayMode` | `"overlay" \| "inline"?` | env var or `"overlay"` | Controls custom UI rendering: `overlay` shows the centered modal (current behavior), `inline` renders without overlay framing |
| `overlayToggleKey` | `string?` | env var or `"alt+o"` | Shortcut for hiding/showing the overlay popup (overlay mode only). Pi-TUI key spec, e.g. `"alt+o"`, `"ctrl+shift+h"`. Pass `"off"` to disable. |
| `commentToggleKey` | `string?` | env var or `"ctrl+g"` | Shortcut for toggling the optional comment/extra-context row when `allowComment: true`. Pass `"off"` to disable. |
| `timeout` | `number?` | — | Auto-dismiss after N ms and return `null` if the prompt times out |

## Example usage shape

```json
{
  "question": "Which option should we use?",
  "context": "We are choosing a deploy target.",
  "options": [
    "staging",
    { "title": "production", "description": "Customer-facing" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "allowComment": true,
  "displayMode": "inline"
}
```

`displayMode: "inline"` uses the same interaction logic but skips overlay mode when calling `ctx.ui.custom(...)`. RPC/headless fallback behavior is unchanged.

## Personal preferences via environment variables

Configure your defaults globally by setting these in your shell profile (`~/.zshrc`, `~/.bash_profile`, etc.):

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### Display mode

Effective order:

1. Per-call `displayMode` parameter (if provided)
2. `PI_ASK_USER_DISPLAY_MODE` (if set to `"overlay"` or `"inline"`)
3. Fallback default: `"overlay"`

Unrecognised values are silently ignored and fall back to `"overlay"`.

### Shortcuts

Effective order for both `overlayToggleKey` and `commentToggleKey`:

1. Per-call parameter (if provided)
2. Matching env var (`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`)
3. Built-in defaults: `alt+o` and `ctrl+g`

Pass `"off"`, `"none"`, or `"disabled"` (at any level) to disable the shortcut entirely. Invalid specs are silently dropped and the next source is used. Specs follow the Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) format: `[mod+]...key` where modifiers are `ctrl`, `shift`, `alt`, `super`, in any order, joined by `+` (e.g. `ctrl+g`, `alt+shift+x`, `escape`, `tab`).

## Overlay notifications via Pi settings

`ask_user` can notify you when an overlay prompt is actually opened. Configure this in Pi settings under `askUser.notifications.mode`:

```json
{
  "askUser": {
    "notifications": {
      "mode": "both"
    }
  }
}
```

Supported modes:

| Mode | Behavior |
|------|----------|
| `"off"` | Do not publish Pi status or desktop notifications. |
| `"status"` | Publish a clearable Pi status key while the overlay is waiting. |
| `"desktop"` | Send a Ghostty desktop notification when the overlay opens. |
| `"both"` | Publish the Pi status key and send the Ghostty desktop notification. This is the default. |

Settings can be configured globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`. Project settings override global settings only when the project value is valid. If a higher-precedence value is invalid, it is ignored and the next lower valid value is used; the default `"both"` is used only when no valid setting exists.

Global example:

```json
{
  "askUser": {
    "notifications": {
      "mode": "status"
    }
  }
}
```

Project-local opt-out example:

```json
{
  "askUser": {
    "notifications": {
      "mode": "off"
    }
  }
}
```

### Notification limitations and privacy

The `status` channel publishes the `ask-user` status key through `ctx.ui.setStatus("ask-user", ...)` and clears it when the prompt finishes. Whether that key is visible depends on your active Pi status surface. With `pi-status-line`, include an `ask-user` status entry in your status-line configuration if you want to see it.

The `desktop` channel uses Ghostty-compatible OSC notification sequences and is intentionally generic: the notification title/body do not include the question, context, or option text, so sensitive prompt content is not written to macOS Notification Center history.

Ghostty OSC 9/777 notifications are currently fire-and-forget from the CLI's perspective. `ask_user` clears the Pi status key on completion, but it cannot reliably dismiss the already-delivered Ghostty desktop notification. Delivery can also be affected by macOS notification permissions, Focus/Do Not Disturb, tmux passthrough, SSH/remote sessions, and terminal compatibility. If you need addressable desktop notification replacement/removal, use a separate macOS helper such as `terminal-notifier`; that is outside this package's built-in Ghostty integration.

## Controls

While an `ask_user` prompt is open:

| Key | Action |
|-----|--------|
| `alt+o` (configurable via `overlayToggleKey`) | Hide/show the overlay popup so you can read the agent's prior output. Available in `overlay` mode only. The first time you hide it, a notification reminds you which key brings it back. |
| `ctrl+g` (configurable via `commentToggleKey`) | Toggle the optional comment/extra-context row (when `allowComment: true`). |
| `enter` | Confirm the focused option, submit a freeform response, or submit/skip an optional comment. |
| `esc` | Clear the search filter, exit freeform/comment mode, or cancel the prompt. |
| `↑` / `↓`, `ctrl+k` / `ctrl+j` | Navigate options. `ctrl+k` / `ctrl+j` (vim-style) work while typing in searchable prompts without disturbing the filter. |

If you prefer never to see the overlay, set `displayMode: "inline"` per call or `PI_ASK_USER_DISPLAY_MODE=inline` globally.

## Result details

All tool results include a structured `details` object for rendering and session state reconstruction:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
}
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).