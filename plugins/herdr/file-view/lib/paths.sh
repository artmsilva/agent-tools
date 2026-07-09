# shellcheck shell=sh
# Shared path resolution for the active-file state file.
#
# The pane runs inside Herdr and gets $HERDR_PLUGIN_STATE_DIR. The Claude Code
# hook runs inside Claude Code's process and does NOT. To let both sides agree
# on one file, the pane writes a "discovery pointer" at a fixed XDG path holding
# the real state-file path; the hook reads it. Resolution precedence:
#   1. $HERDR_FILE_VIEW_ACTIVE   (explicit override, either side)
#   2. $HERDR_PLUGIN_STATE_DIR/active-file   (pane/action, injected by Herdr)
#   3. contents of the discovery pointer   (hook, after the pane has run once)
#   4. XDG fallback   (hook, before the pane has ever run)

fallback_dir() {
	printf '%s' "${XDG_STATE_HOME:-$HOME/.local/state}/herdr-file-view"
}

discovery_pointer() {
	printf '%s' "$(fallback_dir)/state-dir-pointer"
}

resolve_active_file() {
	if [ -n "${HERDR_FILE_VIEW_ACTIVE:-}" ]; then
		printf '%s' "$HERDR_FILE_VIEW_ACTIVE"
		return
	fi
	if [ -n "${HERDR_PLUGIN_STATE_DIR:-}" ]; then
		printf '%s' "$HERDR_PLUGIN_STATE_DIR/active-file"
		return
	fi
	ptr="$(discovery_pointer)"
	if [ -f "$ptr" ]; then
		target="$(cat "$ptr")"
		if [ -n "$target" ]; then
			printf '%s' "$target"
			return
		fi
	fi
	printf '%s' "$(fallback_dir)/active-file"
}

# file_mtime PATH -> epoch seconds (portable across macOS/BSD and Linux/GNU).
file_mtime() {
	stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}
