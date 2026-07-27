# Package instructions

## Scope

Pi `tool_result` hook that spills tool outputs over 8 KiB to a local temp file and replaces them with a bounded head/tail preview plus the file path.

## Validation

```bash
npm run check
```

## Guardrails

- Only `text`-type content blocks are spilled/replaced (`blockText`); non-text blocks (e.g. images) pass through untouched in `replaceTextBlocks`.
- `takeHead`/`takeTail` walk by Unicode character (surrogate-pair aware) and measure UTF-8 byte length per character, not raw string length — preserve this when adjusting preview budgets.
- Preview budget splits 65% head / 35% tail (`Math.ceil(previewBytes * 0.65)`), not an even split; keep this ratio unless intentionally changing the preview shape.
- Spill files are written with mode `0600` into a fresh `mkdtemp` directory per call under the OS temp dir — never reused or cleaned up by the extension itself.
- If the spill write fails, the tool result still returns a preview with an inline error notice (`writeSpill` failure is caught in `spillToolResult`) rather than throwing.
