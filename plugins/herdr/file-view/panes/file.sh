#!/bin/sh
# Pane entrypoint: live preview of the file the coding agent is editing.
# Tails the active-file state file; renders the last-listed path with bat
# (falls back to cat). Re-renders when the tracked path OR its contents change.
set -eu

CDPATH=''
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
. "$DIR/lib/paths.sh"

STATE_FILE=$(resolve_active_file)
mkdir -p "$(dirname "$STATE_FILE")"
[ -f "$STATE_FILE" ] || : >"$STATE_FILE"

# Publish where the state file lives so the Claude Code hook (which lacks
# $HERDR_PLUGIN_STATE_DIR) can find it.
mkdir -p "$(fallback_dir)"
printf '%s' "$STATE_FILE" >"$(discovery_pointer)"

clear_screen() { printf '\033[2J\033[3J\033[H'; }

render() {
	f=$1
	clear_screen
	printf '\033[1;36m▎ %s\033[0m\n' "$f"
	if command -v bat >/dev/null 2>&1; then
		bat --style=numbers --color=always --paging=never "$f" 2>/dev/null || cat "$f"
	else
		cat "$f"
	fi
}

waiting() {
	clear_screen
	printf '\033[1;36m▎ Active File\033[0m\n\n'
	printf 'Waiting for your coding agent to edit a file…\n\n'
	printf 'Set up the Claude Code hook (see README), or run the fallback watcher:\n'
	printf '  sh %s/bin/mru-watch.sh [dir]\n' "$DIR"
}

last_target=""
last_mtime=""

waiting
while :; do
	target=$(tail -n 1 "$STATE_FILE" 2>/dev/null || true)
	if [ -n "$target" ] && [ -f "$target" ]; then
		mtime=$(file_mtime "$target")
		if [ "$target" != "$last_target" ] || [ "$mtime" != "$last_mtime" ]; then
			render "$target"
			last_target=$target
			last_mtime=$mtime
		fi
	elif [ -z "$target" ] && [ -n "$last_target" ]; then
		waiting
		last_target=""
		last_mtime=""
	fi
	sleep 0.5
done
