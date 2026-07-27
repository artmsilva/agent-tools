# Package instructions

## Scope
Pi extension bridging Claude Code user/project/plugin commands, skills, agents, and hooks into pi's extension APIs and event model.

## Validation
- `bun test`
- `npm run typecheck` (runs `tsc --noEmit`)
- `npm run check` (runs `npm pack --dry-run`)

## Guardrails
- Agent registration has no dynamic pi API, so agents are exposed via symlinks in `~/.pi/agent/agents/`; `syncAgentLinks()` may only create/update/prune links it recorded in its own manifest (`pi-claude-bridge-state.json`) — never touch a pre-existing file or foreign symlink at that path (collision -> skip).
- Skills already provided by pi's own discovery (`~/.pi/agent/skills`, `.pi/skills`, `.agents/skills`) must be collision-skipped, not overwritten or duplicated.
- Plugin commands keep their bare name unless it collides, in which case they get a `pluginname:` prefix; existing pi commands always win (collision-skipped), never silently replaced.
- Plugin root resolution prefers `plugins/marketplaces/<marketplace>/plugins/<name>/` and only falls back to the newest semver-ish version under `plugins/cache/<marketplace>/<name>/<version>/` when the marketplace path doesn't exist.
- Only hook handlers with `type: "command"` are bridged; other hook types (`prompt`, `agent`, `http`, `mcp_tool`) and unmappable Claude events (`Notification`, `SubagentStop`, `PostToolBatch`, ...) must be log-skipped, not silently dropped without a trace.
- Hook `exit 2` / blocking `decision` semantics must be translated per the Claude-event -> pi-event table in README (e.g. `PreToolUse` deny -> `{ block, reason }`); don't reinterpret exit codes ad hoc.
