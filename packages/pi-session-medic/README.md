# pi-session-medic

Recover from poisoned pi sessions caused by Anthropic API contract violations.

## Problem

Anthropic's API rejects `tool_result` blocks with `is_error: true` containing non-text content:

> "all content must be type 'text' if 'is_error' is true"

When such a result is persisted in session history, **every subsequent request replays it and gets a 400 → session permanently bricked**.

Related known bug classes:
- [pi#2055](https://github.com/earendil-works/pi/issues/2055) — Oversized image in tool result causes infinite error loop
- Image exceeds 5 MB maximum
- Orphaned `tool_use_id` blocks

## Solution

**pi-session-medic** detects these poison patterns and provides a `/medic` command to repair the session file:

1. Strips non-text content from error `tool_result` blocks
2. Replaces oversized images with text tombstones
3. Writes the repaired session back to disk

Complements the preventive `sanitize-error-results.ts` hook — this fixes sessions that were already poisoned before the prevention hook was installed.

## Installation

```bash
pi install /path/to/agent-tools/packages/pi-session-medic
```

Or add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/agent-tools/packages/pi-session-medic"
  ]
}
```

## Usage

When pi-session-medic detects a poison error, it shows a warning:

```
⚠️  Poison error detected. Run /medic to repair the session.
```

Run the repair command:

```
/medic
```

The extension will:
1. Read the session file (`.jsonl`)
2. Sanitize all poisoned message entries
3. Write the repaired session back
4. Prompt you to reload

Then reload the session to continue:

```
/reload
```

## Limitations

- **Session file required**: Cannot repair ephemeral sessions (`--no-session`)
- **Manual reload**: You must run `/reload` after repair to refresh the in-memory session
- **Detection heuristic**: The `agent_end` detection is best-effort; if you hit a poison error before the extension loads, run `/medic` manually

## What It Fixes

### Error tool results with images

```json
{
  "type": "tool_result",
  "is_error": true,
  "content": [
    { "type": "text", "text": "Screenshot failed" },
    { "type": "image", "data": "...", "mimeType": "image/png" }
  ]
}
```

→ Strips the image, replaces with text tombstone.

### Oversized images (>5MB)

```json
{
  "type": "tool_result",
  "content": [
    { "type": "image", "data": "... 10MB base64 ...", "mimeType": "image/png" }
  ]
}
```

→ Replaces with `[Image removed by pi-session-medic: exceeded 5.0MB limit]`.

## Testing

```bash
npm test
```

Runs unit tests for the pure helper functions:
- `isPoisonError` — pattern matching
- `parseMessageIndex` — error text parsing
- `sanitizeMessages` — stripping non-text from error results
- `stripOversizedImages` — size limit enforcement

## License

MIT
