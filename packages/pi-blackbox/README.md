# pi-blackbox

Flight recorder for pi sessions. Records every tool execution to a local SQLite database at `~/.pi/agent/blackbox.db`.

## What's Recorded

Each tool execution is stored with:
- **Session ID** - ties executions to a specific session
- **Tool name** - which tool was called
- **Started/ended timestamps** - precise timing
- **Duration** - execution time in milliseconds
- **Error flag** - whether the tool call failed
- **Summary** - first 200 chars of the tool result (text content only)
- **Args summary** - first 200 chars of the tool arguments (JSON)

## Schema

```sql
CREATE TABLE tool_executions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  is_error INTEGER NOT NULL,
  summary TEXT,
  args_summary TEXT
);
```

Indexes on `session_id` and `started_at` for fast queries.

## Ring Buffer

The database caps at **20,000 tool execution rows**. When this limit is reached, the oldest rows are automatically pruned on each new insert.

## Usage

### Current Session Timeline

```bash
/blackbox
```

Shows:
- Total tools run
- Error count
- Top 5 slowest tools (with durations and timestamps)
- First error in the session (tool name, timestamp, summary)
- Wall-clock span (time from first to last tool)

### All Sessions

```bash
/blackbox all
```

Same stats, but aggregated across all sessions in the database.

## Privacy Note

- Only the **first 200 chars** of tool results and arguments are stored
- Full file contents are not persisted
- All data stays local in `~/.pi/agent/blackbox.db`

## Error Handling

The extension **fails soft** on all database operations:
- DB open failure → disables silently with a one-time console warning
- Insert/query errors → ignored, never crash the session
- Schema mismatch → ignored

## Installation

Add to your pi config:

```json
{
  "packages": [
    "git:github.com/artmsilva/agent-tools/packages/pi-blackbox"
  ]
}
```

Or use a local directory:

```json
{
  "extensions": [
    "/path/to/agent-tools/packages/pi-blackbox"
  ]
}
```

## License

MIT
