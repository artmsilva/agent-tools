# pi-agent-browser

Lean [pi](https://github.com/badlogic/pi-mono) extension exposing the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI as a native `agent_browser` tool.

Spiritual fork of `pi-agent-browser-native` (92 files, 1.2 MB) reduced to one file, keeping what's
good — a pi-native tool, not MCP — and fixing what's bad:

- **Session-poisoning bug fixed by construction.** Errors are *thrown*, so pi reports them as
  text-only `isError` results. The original could return image content with `isError: true`,
  which Anthropic's API rejects (`all content must be type 'text' if 'is_error' is true`) —
  permanently bricking the session.
- **The CLI teaches itself.** No 3 KB tool schema; the description points the model at
  `agent-browser skills get core`, which always matches the installed CLI version.
- **TOON output.** `--json` results are re-encoded as [TOON](https://github.com/toon-format/toon)
  (~40–60 % fewer tokens than JSON).
- **Screenshots attach as images** — on success only.

## Install

```bash
npm i -g agent-browser && agent-browser install   # the CLI itself
pi install /path/to/agent-tools/packages/pi-agent-browser
# remove the old extension first if present: pi remove npm:pi-agent-browser-native
```

## Tool surface

`agent_browser({ args: string[], stdin?, timeoutMs? })` — exact CLI args, no shell quoting.
`--json` is appended automatically (except for `skills`/`install`/`help`) and the JSON result
comes back as TOON. Output capped at 50 KB; default timeout 120 s.

## Test

```bash
npm test
```
