# Package instructions

## Scope

Grab-bag of independent Pi extensions (context-file-sibling, dcg-guard, open-zed, open-hunk, sanitize-error-results, worktree, gh-stack, job-poller) installed by path, not published.

## Validation

Run `npm test` for the `gh-stack` command builder, job-poller status detection, and `context-file-sibling`'s injection planning. Other extensions have no package-level checks.

## Guardrails

- Each `.ts` file is a standalone extension registered directly in `package.json`'s `pi.extensions` array; there is no shared entry point or `src/` layout.
- `dcg-guard.ts` fails open (allows the command) if the `dcg` binary errors or exits with code other than 1, and it blocks the *entire* tool call on a match — including safe segments of a `&&` chain that hasn't run yet.
- `context-file-sibling.ts` works around pi loading `AGENTS.md` **or** `CLAUDE.md` per directory rather than both. It compares `realpath` before injecting, so a symlinked pair is a no-op, and it skips any directory containing `AGENTS.override.md` because that file is a deliberate replacement. Oversized siblings are named, never truncated — a half-pasted instruction file is worse than a pointer to the whole one.
- `sanitize-error-results.ts` only rewrites `tool_result` events where `isError` is true and contains non-text blocks; it exists as a workaround for an upstream Anthropic/pi-ai contract bug and should be removed once that's fixed upstream, not extended.
- `worktree.ts` defaults to isolated APFS copy-on-write (`cow`) node_modules. `symlink` is explicit opt-in because workspace package links can resolve to the main checkout and installs mutate the shared source.
- `worktree.ts` places new worktrees under a hardcoded `~/Github/.worktrees/<repo>` base path, not a config-relative one.
- `gh-stack.ts` wraps GitHub's public-preview `gh stack` extension. Interactive commands are excluded or forced non-interactive (`submit --auto`, `merge --yes`).
- `open-zed.ts` shells out to `zed` and `git rev-parse --show-toplevel`; it silently falls back to `ctx.cwd` if the repo root lookup fails.
- `open-hunk.ts` hardcodes `Ghostty.app` via `open -na Ghostty.app --args -e hunk diff --watch`; it silently no-ops (well, errors) on any other terminal app. It shares `open-zed.ts`'s worktree-root fallback to `ctx.cwd`.
