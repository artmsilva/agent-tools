# Package instructions

## Scope

Grab-bag of independent Pi extensions (dcg-guard, open-zed, open-hunk, sanitize-error-results, worktree) installed by path, not published.

## Validation

No `scripts` in `package.json` — there is no test, build, or check command to run for this package.

## Guardrails

- Each `.ts` file is a standalone extension registered directly in `package.json`'s `pi.extensions` array; there is no shared entry point or `src/` layout.
- `dcg-guard.ts` fails open (allows the command) if the `dcg` binary errors or exits with code other than 1, and it blocks the *entire* tool call on a match — including safe segments of a `&&` chain that hasn't run yet.
- `sanitize-error-results.ts` only rewrites `tool_result` events where `isError` is true and contains non-text blocks; it exists as a workaround for an upstream Anthropic/pi-ai contract bug and should be removed once that's fixed upstream, not extended.
- `worktree.ts`'s `symlink` node_modules mode links to the main worktree's shared install — running `npm install` inside a symlink-mode worktree mutates that shared install; use `cow` or `copy` for isolation.
- `worktree.ts` places new worktrees under a hardcoded `~/Github/.worktrees/<repo>` base path, not a config-relative one.
- `open-zed.ts` shells out to `zed` and `git rev-parse --show-toplevel`; it silently falls back to `ctx.cwd` if the repo root lookup fails.
- `open-hunk.ts` hardcodes `Ghostty.app` via `open -na Ghostty.app --args -e hunk diff --watch`; it silently no-ops (well, errors) on any other terminal app. It shares `open-zed.ts`'s worktree-root fallback to `ctx.cwd`.
