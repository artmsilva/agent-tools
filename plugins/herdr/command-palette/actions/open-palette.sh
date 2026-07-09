#!/bin/sh
# Action: open the command palette overlay.
set -eu

state_dir=${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-command-palette}
mkdir -p "$state_dir"
context_file="$state_dir/context.json"
printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-{}}" >"$context_file"

exec "$HERDR_BIN_PATH" plugin pane open \
	--plugin "$HERDR_PLUGIN_ID" \
	--entrypoint palette \
	--placement overlay \
	--env "HERDR_PALETTE_CONTEXT_FILE=$context_file" \
	--focus
