#!/bin/sh
# Fallback file tracker for agents without an editing hook (e.g. pi).
# Watches a directory (default: cwd) and writes the most-recently-modified
# regular file to the active-file state file the preview pane tails.
# Prefers fswatch for event-driven updates; falls back to polling.
#
# Usage: sh bin/mru-watch.sh [dir]
set -eu

CDPATH=''
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
. "$DIR/lib/paths.sh"

WATCH_DIR=${1:-$PWD}
STATE_FILE=$(resolve_active_file)
mkdir -p "$(dirname "$STATE_FILE")"
mkdir -p "$(fallback_dir)"
printf '%s' "$STATE_FILE" >"$(discovery_pointer)"

mru() {
	find "$WATCH_DIR" -type f \
		-not -path '*/.git/*' \
		-not -path '*/node_modules/*' \
		2>/dev/null |
		while IFS= read -r f; do
			printf '%s\t%s\n' "$(file_mtime "$f")" "$f"
		done |
		sort -nr | head -n1 | cut -f2-
}

publish() {
	newest=$(mru)
	[ -n "$newest" ] || return 0
	if [ "$newest" != "${LAST:-}" ]; then
		printf '%s\n' "$newest" >>"$STATE_FILE"
		LAST=$newest
	fi
}

echo "watching $WATCH_DIR -> $STATE_FILE"
publish

if command -v fswatch >/dev/null 2>&1; then
	# -o batches events into a single line per change burst.
	fswatch -o "$WATCH_DIR" | while read -r _; do publish; done
else
	while :; do
		publish
		sleep 2
	done
fi
