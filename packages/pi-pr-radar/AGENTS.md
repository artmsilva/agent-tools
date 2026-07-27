# Package instructions

## Scope

Pi extension: polls `gh pr list` for the current user's open PRs and renders a footer status + `/prs` command + `alt+p` shortcut.

## Validation

```bash
npm test
```

## Guardrails

- Requires GitHub CLI (`gh`) installed and authenticated; must degrade silently (no thrown errors, footer hidden) when `gh` is missing, unauthenticated, or offline — see `fetchPrs`'s try/catch.
- `alt+p` shell-opens the worst PR via macOS `open`; this only works on macOS.
- `updateFooter`/poll timers must tolerate a stale `ExtensionContext` (session reloaded mid-poll) — `ctx.ui.setStatus` calls are wrapped in try/catch and clear `currentCtx` on failure; don't remove that guard.
- The poll `setInterval` is `unref()`'d and cleared on `session_shutdown`; new timer logic must preserve both to avoid keeping the process alive or leaking timers across reloads.
