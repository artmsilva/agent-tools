# pi-spill

A tiny circuit breaker for Pi's context window.

When a tool returns more than 8 KiB of text, pi-spill saves the full result to a
private local temp file before the result enters model context. The model gets a
4 KiB head/tail preview plus the file path for later inspection.

## Why

The useful idea behind Context Mode was simple: raw bulk data should stay local;
only the useful slice should reach the model. pi-spill keeps that idea and drops
the rest.

- one `tool_result` hook
- no MCP server
- no custom tools
- no SQLite or search index
- no model calls
- no platform adapters

## Install

```bash
pi install /path/to/agent-tools/packages/pi-spill
```

Or try it for one run:

```bash
pi -e /path/to/agent-tools/packages/pi-spill/index.ts
```

## Behavior

Small results pass through unchanged. Large textual results become:

```text
<start of output>

… 43.2 KiB omitted …

<end of output>

[pi-spill: 47.2 KiB saved to /tmp/pi-spill-.../bash.txt. Use read or bash to inspect it.]
```

Non-text content such as images is preserved. Spill files use mode `0600` inside
the operating system temp directory.

## Non-goals

pi-spill does not summarize, index, rank, remember, fetch, execute, or sync
anything. Existing Pi tools can inspect a spill file when the preview is not
enough.

## License

MIT
