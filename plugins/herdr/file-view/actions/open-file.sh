#!/bin/sh
# Action: open the active-file preview as a right-hand split.
set -eu
exec "$HERDR_BIN_PATH" plugin pane open \
	--plugin "$HERDR_PLUGIN_ID" \
	--entrypoint file \
	--placement split \
	--direction right
