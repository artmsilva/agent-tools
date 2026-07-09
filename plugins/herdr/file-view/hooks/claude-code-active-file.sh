#!/bin/sh
# Claude Code PostToolUse hook (matcher: Edit|Write|MultiEdit).
# Reads the hook payload on stdin, resolves the edited file to an absolute path,
# and appends it to the active-file state file the preview pane tails.
set -eu

CDPATH=''
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
. "$DIR/lib/paths.sh"

payload=$(cat)

# Extract tool_input.file_path and cwd. Prefer jq; fall back to node.
if command -v jq >/dev/null 2>&1; then
	fp=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
	cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
elif command -v node >/dev/null 2>&1; then
	fp=$(HERDR_PAYLOAD="$payload" node -e 'const d=JSON.parse(process.env.HERDR_PAYLOAD||"{}");process.stdout.write((d.tool_input&&d.tool_input.file_path)||"")')
	cwd=$(HERDR_PAYLOAD="$payload" node -e 'const d=JSON.parse(process.env.HERDR_PAYLOAD||"{}");process.stdout.write(d.cwd||"")')
else
	# No JSON parser available; nothing we can safely do.
	exit 0
fi

[ -n "$fp" ] || exit 0

# Resolve to an absolute path (Claude Code sends absolute already; be defensive).
case "$fp" in
	/*) abs="$fp" ;;
	*) abs="${cwd:-$PWD}/$fp" ;;
esac

STATE_FILE=$(resolve_active_file)
mkdir -p "$(dirname "$STATE_FILE")"
printf '%s\n' "$abs" >>"$STATE_FILE"

exit 0
