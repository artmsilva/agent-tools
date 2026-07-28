# pi-toolspace

A local, read-only dashboard for Pi and Claude Code tooling.

It maps skills, agents, commands, MCP servers, plugins, hooks, source configuration, overrides, and broken links. It reads only configuration structure: no auth data, secret values, session transcripts, or history.

## Run

```sh
node cli.mjs
# Toolspace → http://127.0.0.1:4288
```

Choose a port when needed:

```sh
node cli.mjs --port 4290
```

The dashboard binds only to `127.0.0.1`. Use **Rescan** to refresh the snapshot; it never edits configuration.

## Test

```sh
npm test
```

## What it reads

- `~/.pi/agent/{settings,mcp}.json` and Pi resource folders
- `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/.mcp.json`
- `~/.claude/plugins/installed_plugins.json`

The scanner intentionally extracts names, counts, paths, and configured transport types only. It does not return OAuth config, environment values, permission rules, or arbitrary setting content.
