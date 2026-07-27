# Package instructions

## Scope
Pi extension adding an interactive `ask_user` tool (searchable single/multi-select UI, freeform input, overlay/inline modes) plus a bundled `ask-user` decision-gating skill.

## Validation
- `bun test index.test.ts single-select-layout.test.ts` (package.json has no `test` script; tests import `bun:test` and use TS parameter properties, so plain `node --test` fails — bun is the working runner)
- `npm run check` (runs `npm pack --dry-run`)

## Guardrails
- Never call `getMarkdownTheme()` without also validating the returned bag before use — a stale/mismatched host module instance can hand back a Proxy that only throws on property access, silently escaping a bare `try/catch` and crashing mid-render.
- `StringEnum()` is a local copy of pi-ai's helper kept to emit flat `{type, enum}` schemas instead of `anyOf`/`oneOf`, because Google's function-calling API rejects the union form — don't replace it with `Type.Union([Type.Literal(...)])`.
- The overlay-toggle key (`alt+o` default; `overlayToggleKey` or `PI_ASK_USER_OVERLAY_TOGGLE_KEY`) and comment-toggle key (`ctrl+g`; `commentToggleKey` or `PI_ASK_USER_COMMENT_TOGGLE_KEY`) are user-facing keybindings relied on by the bundled skill — don't rebind them without updating `skills/ask-user`.
- `details` on every tool result (`AskToolDetails`) is used for session state reconstruction; keep its shape (`response: AskResponse | null`, `cancelled`) stable.
- Falls back gracefully to a non-interactive prompt when the TUI overlay is unavailable — don't assume a terminal UI is always present.
