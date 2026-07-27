# Package instructions

## Scope
Single-file (`index.ts`) pi extension wrapping the external `agent-browser` CLI as the `agent_browser` tool.

## Validation
- `npm test` (runs `node --test`)
- `npm run check` (runs `npm pack --dry-run`)

## Guardrails
- Errors from `execute()` must always be `throw`n, never returned as content — a returned `isError` result with image content is rejected by Anthropic's API and permanently poisons the session (the bug this package fixes by construction).
- `screenshotPath()` only attaches an image when `args[0] === "screenshot"` and a `.png`/`.jpg`/`.jpeg` path is present; screenshot attach failures are swallowed (best-effort) so they never fail the tool call.
- `buildArgv()` must not append `--json` for `NO_JSON_SUBCOMMANDS` (`skills`, `install`, `help`, `--help`, `-h`, `--version`, `-V`) or when `--json` is already present.
- Output is capped at `MAX_OUTPUT_BYTES` (50,000 chars) and images at `MAX_IMAGE_BYTES` (4 MB); do not remove these caps.
- The `agent-browser` binary itself is an external dependency, not vendored here — it must be installed separately (`npm i -g agent-browser && agent-browser install`).
