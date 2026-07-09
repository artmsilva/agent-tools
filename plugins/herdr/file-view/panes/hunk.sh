#!/bin/sh
# Pane entrypoint: live Hunk diff for the focused agent/workspace checkout.
set -eu

clear_screen() { printf '\033[2J\033[3J\033[H'; }

clear_screen
printf '\033[1;36m▎ Current Diff (Hunk)\033[0m\n\n'

HUNK_BIN=$(command -v hunk 2>/dev/null || true)
if [ -z "$HUNK_BIN" ]; then
	for candidate in /opt/homebrew/bin/hunk /usr/local/bin/hunk "$HOME/.local/bin/hunk"; do
		if [ -x "$candidate" ]; then
			HUNK_BIN=$candidate
			break
		fi
	done
fi

if [ -z "$HUNK_BIN" ]; then
	cat <<'EOF'
Hunk is not installed or not on this pane's PATH.

Install it with one of:
  brew install hunk
  npm i -g hunkdiff
EOF
	exit 0
fi

if ! git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	cat <<EOF
No Git checkout found for this pane.

cwd: $PWD
source cwd: ${HERDR_HUNK_SOURCE_CWD:-unknown}

Focus an agent pane inside a Git repo, then open Current Diff again.
EOF
	exit 0
fi

repo=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")
cd "$repo"

# Hunk's own working-tree loader includes untracked files. --watch keeps the
# pane updated as the agent edits.
exec "$HUNK_BIN" diff --watch
