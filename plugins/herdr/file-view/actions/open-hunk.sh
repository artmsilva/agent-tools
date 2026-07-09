#!/bin/sh
# Action: open a Hunk diff viewer for the focused agent/workspace checkout.
set -eu

context=${HERDR_PLUGIN_CONTEXT_JSON:-{}}

json_field() {
	field=$1
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$context" | jq -r "$field // empty" 2>/dev/null || true
	elif command -v node >/dev/null 2>&1; then
		HERDR_CONTEXT_JSON=$context HERDR_FIELD=$field node <<'NODE' 2>/dev/null || true
const data = JSON.parse(process.env.HERDR_CONTEXT_JSON || '{}');
const field = process.env.HERDR_FIELD || '';
const path = field.replace(/^\./, '').split('.').filter(Boolean);
let value = data;
for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined;
if (typeof value === 'string') process.stdout.write(value);
NODE
	fi
}

focused_cwd=$(json_field '.focused_pane_cwd')
worktree_checkout=$(json_field '.worktree.checkout_path')
workspace_cwd=$(json_field '.workspace_cwd')

# Prefer the focused agent pane's cwd, then Herdr worktree metadata, then the
# workspace cwd, then this action's cwd. Open Hunk at the Git root when found.
repo_cwd=""
for candidate in "$focused_cwd" "$worktree_checkout" "$workspace_cwd" "$PWD"; do
	[ -n "$candidate" ] || continue
	root=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null || true)
	if [ -n "$root" ]; then
		repo_cwd=$root
		break
	fi
done

if [ -z "$repo_cwd" ]; then
	repo_cwd=${focused_cwd:-${workspace_cwd:-$PWD}}
fi

exec "$HERDR_BIN_PATH" plugin pane open \
	--plugin "$HERDR_PLUGIN_ID" \
	--entrypoint hunk \
	--placement split \
	--direction right \
	--cwd "$repo_cwd" \
	--env "HERDR_HUNK_SOURCE_CWD=${focused_cwd:-$workspace_cwd}"
