# pi-claude-bridge

Make Claude Code content work in [pi](https://github.com/earendil-works/pi-mono) automatically — including **user-scope** resources and **installed Claude plugins with their hooks** — so new Claude plugins appear in pi with zero manual wiring.

A fork/supersession of [@entelligentsia/pi-claude-compat](https://github.com/Entelligentsia/pi-claude-compat) (MIT). See [NOTICE](./NOTICE) for attribution; the project-scope discovery, `$ARGUMENTS` substitution, frontmatter parsing, and the `/claude-commands` / `/claude-load` / `/claude-unload` management commands originate there.

## What it loads

| Source | Commands | Skills | Agents | Hooks |
|---|---|---|---|---|
| Project `.claude/` (cwd) | `commands/**/*.md` | `skills/*/SKILL.md` | — | — |
| User `~/.claude/` | `commands/**/*.md` | `skills/*/SKILL.md` | `agents/*.md` | `settings.json` `hooks` |
| Enabled Claude plugins | `<root>/commands` | `<root>/skills` | `<root>/agents` | `<root>/hooks/hooks.json` |

Plugins come from `~/.claude/settings.json` `enabledPlugins` (`"name@marketplace": true`). Each root resolves to `~/.claude/plugins/marketplaces/<marketplace>/plugins/<name>/` when present, otherwise the newest version under `~/.claude/plugins/cache/<marketplace>/<name>/<version>/` (semver-ish sort; tolerates `unknown`).

- **Commands** register as pi slash commands (nested dirs -> `:`, e.g. `/xyz:test1`). Plugin commands keep their bare name unless it clashes, then get a `pluginname:` prefix. Existing pi commands are collision-skipped and reported.
- **Skills** register natively via pi's `resources_discover` event. Anything already provided by pi (`~/.pi/agent/skills`, `.pi/skills`, `.agents/skills` — e.g. install.sh-managed symlinks) is collision-skipped, logged, never touched.
- **Agents** have no dynamic pi registration API, so the bridge maintains symlinks in `~/.pi/agent/agents/` (consumed by `npm:@tintinweb/pi-subagents`). Links are tracked in `~/.pi/agent/pi-claude-bridge-state.json`; only bridge-created links are ever retargeted or pruned.

## Hooks bridge

Claude hook handlers (`type: "command"` only) run with the Claude-schema JSON payload on stdin and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PROJECT_DIR` in the environment. Default timeout 60s (per-hook `timeout` respected; SessionEnd capped at 5s). Exit 0 stdout is parsed as JSON control output; exit 2 applies Claude's blocking semantics where pi allows it.

| Claude event | pi event | Semantics bridged |
|---|---|---|
| `SessionStart` | `session_start` | stdout / `additionalContext` injected as next-turn context |
| `SessionEnd` | `session_shutdown` | side effects only (capped timeout) |
| `PreToolUse` | `tool_call` | exit 2 / `permissionDecision: "deny"` -> `{ block, reason }`; `updatedInput` mutates tool args |
| `PostToolUse` | `tool_result` | `decision: "block"` reason + `additionalContext` appended to the tool result |
| `UserPromptSubmit` | `before_agent_start` | stdout / `additionalContext` injected; prompt blocking unsupported (logged) |
| `Stop` | `agent_end` | `decision: "block"` -> follow-up message continues the agent (8-block cap) |
| `PreCompact` | `session_before_compact` | exit 2 / `decision: "block"` -> `{ cancel: true }` |

Unmappable events (`Notification`, `SubagentStop`, `PostToolBatch`, ...) and non-command hook types (`prompt`, `agent`, `http`, `mcp_tool`) are log-skipped — visible via `/claude-commands`.

Tool names and inputs are translated to Claude's schema (`bash` -> `Bash` `{command}`, `edit` -> `Edit` `{file_path, old_string, new_string}`, `find` -> `Glob`, ...), and matchers follow Claude's rules (exact / `|`,`,` lists / regex).

## Commands

- `/claude-commands` — list loaded plugins, commands, skills, agents, hook sources, and recent bridge log
- `/claude-unload` / `/claude-load` — toggle everything off/on (persisted per-project under `.pi/pi-claude-bridge/`)

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["/path/to/agent-tools/packages/pi-claude-bridge"] }
```

Set `PI_CLAUDE_BRIDGE_DEBUG=1` to echo bridge logs to stderr.

## Development

```bash
npm install      # dev types
npm run typecheck
bun test
```
