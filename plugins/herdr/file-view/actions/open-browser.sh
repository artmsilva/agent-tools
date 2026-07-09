#!/bin/sh
# Action: open the agent-browser frame preview as a right-hand split.
set -eu
exec "$HERDR_BIN_PATH" plugin pane open \
	--plugin "$HERDR_PLUGIN_ID" \
	--entrypoint browser \
	--placement split \
	--direction right
