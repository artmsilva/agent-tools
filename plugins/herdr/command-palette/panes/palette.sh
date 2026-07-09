#!/bin/sh
# Pane entrypoint: fzf-style Herdr command palette.
set -eu

CDPATH=''
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
. "$DIR/lib/json-field.sh"

context='{}'
if [ -n "${HERDR_PALETTE_CONTEXT_FILE:-}" ] && [ -f "$HERDR_PALETTE_CONTEXT_FILE" ]; then
	context=$(cat "$HERDR_PALETTE_CONTEXT_FILE")
fi

focused_pane_id=$(json_field "$context" '.focused_pane_id')
workspace_id=$(json_field "$context" '.workspace_id')
workspace_label=$(json_field "$context" '.workspace_label')
workspace_cwd=$(json_field "$context" '.workspace_cwd')
tab_id=$(json_field "$context" '.tab_id')
tab_label=$(json_field "$context" '.tab_label')
focused_cwd=$(json_field "$context" '.focused_pane_cwd')
focused_agent=$(json_field "$context" '.focused_pane_agent')

herdr=${HERDR_BIN_PATH:-herdr}

clear_screen() { printf '\033[2J\033[3J\033[H'; }

require_pane() {
	if [ -z "$focused_pane_id" ]; then
		clear_screen
		printf 'No focused pane in invocation context.\n'
		sleep 1
		exit 0
	fi
}

require_tab() {
	if [ -z "$tab_id" ]; then
		clear_screen
		printf 'No tab in invocation context.\n'
		sleep 1
		exit 0
	fi
}

require_workspace() {
	if [ -z "$workspace_id" ]; then
		clear_screen
		printf 'No workspace in invocation context.\n'
		sleep 1
		exit 0
	fi
}

prompt_line() {
	label=$1
	default=${2:-}
	clear_screen
	printf '\033[1;36m▎ %s\033[0m\n\n' "$label" >&2
	if [ -n "$default" ]; then
		printf 'Current: %s\n\n' "$default" >&2
	fi
	printf '> ' >&2
	IFS= read -r value || exit 0
	printf '%s' "$value"
}

pause_msg() {
	clear_screen
	printf '%s\n\n' "$1"
	printf 'Press enter… '
	IFS= read -r _ || true
}

run_in_focused_cwd() {
	cmd=$1
	cwd=${focused_cwd:-${workspace_cwd:-$PWD}}
	exec sh -lc "cd \"\$1\" && exec $cmd" sh "$cwd"
}

open_plugin_action() {
	action=$1
	# Fire-and-forget. If the target plugin is missing, Herdr prints the error.
	exec "$herdr" plugin action invoke "$action"
}

items=$(cat <<'ITEMS'
# Plugin quick actions	noop
Open current diff (Hunk)	plugin:io.github.artmsilva.file-view.open-hunk
Open active file preview	plugin:io.github.artmsilva.file-view.open-file
Open agent-browser preview	plugin:io.github.artmsilva.file-view.open-browser

# Herdr app / prefix actions	noop
Help (prefix+?)	info:Open Herdr help with prefix+?
Settings (prefix+s)	info:Open Herdr settings with prefix+s
Detach (prefix+q)	info:Detach with prefix+q
Reload Herdr config (prefix+shift+r)	herdr:server.reload-config
Open notification target (prefix+o)	info:Use prefix+o; no CLI hook exposed
Workspace picker (prefix+w)	herdr:workspace.pick
Goto mode (prefix+g)	info:Use prefix+g; no CLI hook exposed
Toggle sidebar (prefix+b)	info:Use prefix+b; no CLI hook exposed

# Workspaces / worktrees	noop
New workspace (prefix+shift+n)	herdr:workspace.create
Rename workspace (prefix+shift+w)	herdr:workspace.rename
Close workspace (prefix+shift+d)	herdr:workspace.close
Previous workspace	herdr:workspace.previous
Next workspace	herdr:workspace.next
Open workspace picker	herdr:workspace.pick
New worktree (prefix+shift+g)	herdr:worktree.create
Open worktree	herdr:worktree.open
Remove worktree	herdr:worktree.remove

# Tabs	noop
New tab (prefix+c)	herdr:tab.create
Rename tab (prefix+shift+t)	herdr:tab.rename
Previous tab (prefix+p)	herdr:tab.previous
Next tab (prefix+n)	herdr:tab.next
Switch tab… (prefix+1..9)	herdr:tab.pick
Close tab (prefix+shift+x)	herdr:tab.close

# Panes	noop
Rename pane (prefix+shift+p)	herdr:pane.rename
Clear pane name	herdr:pane.rename.clear
Edit/read scrollback (prefix+e)	herdr:pane.read
Focus pane left (prefix+h)	herdr:pane.focus.left
Focus pane down (prefix+j)	herdr:pane.focus.down
Focus pane up (prefix+k)	herdr:pane.focus.up
Focus pane right (prefix+l)	herdr:pane.focus.right
Cycle pane next (prefix+tab)	herdr:pane.cycle.next
Cycle pane previous (prefix+shift+tab)	herdr:pane.cycle.previous
Swap pane left (prefix+shift+h)	herdr:pane.swap.left
Swap pane down (prefix+shift+j)	herdr:pane.swap.down
Swap pane up (prefix+shift+k)	herdr:pane.swap.up
Swap pane right (prefix+shift+l)	herdr:pane.swap.right
Split vertical / right (prefix+v)	herdr:pane.split.right
Split horizontal / down (prefix+minus)	herdr:pane.split.down
Close focused pane (prefix+x)	herdr:pane.close
Zoom focused pane (prefix+z)	herdr:pane.zoom
Resize pane left	herdr:pane.resize.left
Resize pane down	herdr:pane.resize.down
Resize pane up	herdr:pane.resize.up
Resize pane right	herdr:pane.resize.right
Resize mode (prefix+r)	info:Use prefix+r; interactive resize mode has no CLI hook

# Agents	noop
Focus previous agent	herdr:agent.previous
Focus next agent	herdr:agent.next
Focus agent…	herdr:agent.pick

# Shell tools in focused cwd	noop
Lazygit in focused cwd	shell:lazygit
Git status in focused cwd	shell:git status --short --branch && printf '\nPress enter…' && read _
Hunk diff here	shell:hunk diff --watch
ITEMS
)

choose_with_fzf() {
	printf '%s\n' "$items" | awk -F '\t' 'NF >= 2' | fzf \
		--ansi \
		--height=100% \
		--layout=reverse \
		--border=rounded \
		--prompt='Herdr › ' \
		--delimiter='\t' \
		--with-nth=1 \
		--preview='printf "%s\n" {2}' \
		--preview-window=down:3:wrap
}

choose_without_fzf() {
	clear_screen
	printf '\033[1;36m▎ Herdr Command Palette\033[0m\n\n'
	printf 'Install fzf for fuzzy search: brew install fzf\n\n'
	printf '%s\n' "$items" | awk -F '\t' 'NF >= 2 {printf "%2d) %s\n", ++n, $1}'
	printf '\nSelect action number: '
	IFS= read -r n || exit 0
	case $n in
		''|*[!0-9]*) exit 0 ;;
	esac
	printf '%s\n' "$items" | awk -F '\t' -v want="$n" 'NF >= 2 {n++} n == want {print; exit}'
}

json_array_ids() {
	jq_filter=$1
	if ! command -v jq >/dev/null 2>&1; then
		return 1
	fi
	printf '%s' "$2" | jq -r "$jq_filter" 2>/dev/null || true
}

pick_tab() {
	require_workspace
	json=$("$herdr" tab list --workspace "$workspace_id" 2>/dev/null || true)
	[ -n "$json" ] || return 1
	choice=$(printf '%s' "$json" | jq -r '.result.tabs[] | [.label, .tab_id] | @tsv' | fzf --prompt='Tab › ' --delimiter='\t' --with-nth=1 || true)
	[ -n "$choice" ] || exit 0
	printf '%s' "$choice" | awk -F '\t' '{print $2}'
}

focus_relative_tab() {
	dir=$1
	require_workspace
	[ -n "$tab_id" ] || tab_id=$("$herdr" tab list --workspace "$workspace_id" | jq -r '.result.tabs[] | select(.focused == true) | .tab_id' | head -1)
	json=$("$herdr" tab list --workspace "$workspace_id")
	target=$(printf '%s' "$json" | jq -r --arg current "$tab_id" --arg dir "$dir" '
		.result.tabs as $tabs
		| ($tabs | map(.tab_id) | index($current)) as $i
		| if $i == null then empty
		  elif $dir == "next" then $tabs[(($i + 1) % ($tabs | length))].tab_id
		  else $tabs[(($i - 1 + ($tabs | length)) % ($tabs | length))].tab_id end
	')
	[ -n "$target" ] || exit 0
	exec "$herdr" tab focus "$target"
}

pick_workspace() {
	json=$("$herdr" workspace list 2>/dev/null || true)
	[ -n "$json" ] || return 1
	choice=$(printf '%s' "$json" | jq -r '.result.workspaces[] | [.label, .workspace_id] | @tsv' | fzf --prompt='Workspace › ' --delimiter='\t' --with-nth=1 || true)
	[ -n "$choice" ] || exit 0
	printf '%s' "$choice" | awk -F '\t' '{print $2}'
}

focus_relative_workspace() {
	dir=$1
	[ -n "$workspace_id" ] || exit 0
	json=$("$herdr" workspace list)
	target=$(printf '%s' "$json" | jq -r --arg current "$workspace_id" --arg dir "$dir" '
		.result.workspaces as $ws
		| ($ws | map(.workspace_id) | index($current)) as $i
		| if $i == null then empty
		  elif $dir == "next" then $ws[(($i + 1) % ($ws | length))].workspace_id
		  else $ws[(($i - 1 + ($ws | length)) % ($ws | length))].workspace_id end
	')
	[ -n "$target" ] || exit 0
	exec "$herdr" workspace focus "$target"
}

focus_relative_pane() {
	dir=$1
	require_pane
	require_workspace
	json=$("$herdr" pane list --workspace "$workspace_id")
	target=$(printf '%s' "$json" | jq -r --arg current "$focused_pane_id" --arg dir "$dir" '
		.result.panes as $panes
		| ($panes | map(.pane_id) | index($current)) as $i
		| if $i == null then empty
		  elif $dir == "next" then $panes[(($i + 1) % ($panes | length))].pane_id
		  else $panes[(($i - 1 + ($panes | length)) % ($panes | length))].pane_id end
	')
	[ -n "$target" ] || exit 0
	exec "$herdr" pane focus --pane "$target"
}

pick_agent() {
	json=$("$herdr" agent list 2>/dev/null || true)
	[ -n "$json" ] || return 1
	choice=$(printf '%s' "$json" | jq -r '.result.agents[] | [.agent, .agent_status, .pane_id] | @tsv' | fzf --prompt='Agent › ' --delimiter='\t' --with-nth=1,2 || true)
	[ -n "$choice" ] || exit 0
	printf '%s' "$choice" | awk -F '\t' '{print $3}'
}

focus_relative_agent() {
	dir=$1
	json=$("$herdr" agent list 2>/dev/null || true)
	[ -n "$json" ] || exit 0
	current=${focused_pane_id:-}
	target=$(printf '%s' "$json" | jq -r --arg current "$current" --arg dir "$dir" '
		.result.agents as $agents
		| ($agents | map(.pane_id) | index($current)) as $i
		| if ($agents | length) == 0 then empty
		  elif $i == null then $agents[0].pane_id
		  elif $dir == "next" then $agents[(($i + 1) % ($agents | length))].pane_id
		  else $agents[(($i - 1 + ($agents | length)) % ($agents | length))].pane_id end
	')
	[ -n "$target" ] || exit 0
	exec "$herdr" pane focus --pane "$target"
}

if command -v fzf >/dev/null 2>&1; then
	selected=$(choose_with_fzf || true)
else
	selected=$(choose_without_fzf || true)
fi

[ -n "$selected" ] || exit 0

action=$(printf '%s' "$selected" | awk -F '\t' '{print $2}')

case $action in
	noop)
		exit 0
		;;
	info:*)
		pause_msg "${action#info:}"
		;;
	plugin:*)
		open_plugin_action "${action#plugin:}"
		;;
	herdr:server.reload-config)
		exec "$herdr" server reload-config
		;;
	herdr:workspace.create)
		label=$(prompt_line 'New workspace label (optional)')
		cwd=$(prompt_line 'New workspace cwd (optional)' "${workspace_cwd:-$PWD}")
		if [ -n "$label" ] && [ -n "$cwd" ]; then
			exec "$herdr" workspace create --label "$label" --cwd "$cwd" --focus
		elif [ -n "$label" ]; then
			exec "$herdr" workspace create --label "$label" --focus
		elif [ -n "$cwd" ]; then
			exec "$herdr" workspace create --cwd "$cwd" --focus
		fi
		exec "$herdr" workspace create --focus
		;;
	herdr:workspace.rename)
		require_workspace
		label=$(prompt_line 'Rename workspace' "$workspace_label")
		[ -n "$label" ] || exit 0
		exec "$herdr" workspace rename "$workspace_id" "$label"
		;;
	herdr:workspace.close)
		require_workspace
		exec "$herdr" workspace close "$workspace_id"
		;;
	herdr:workspace.previous)
		focus_relative_workspace previous
		;;
	herdr:workspace.next)
		focus_relative_workspace next
		;;
	herdr:workspace.pick)
		target=$(pick_workspace)
		[ -n "$target" ] || exit 0
		exec "$herdr" workspace focus "$target"
		;;
	herdr:worktree.create)
		branch=$(prompt_line 'New worktree branch')
		[ -n "$branch" ] || exit 0
		base=$(prompt_line 'Base ref (optional)' 'origin/main')
		if [ -n "$base" ]; then
			exec "$herdr" worktree create --workspace "$workspace_id" --branch "$branch" --base "$base" --focus
		fi
		exec "$herdr" worktree create --workspace "$workspace_id" --branch "$branch" --focus
		;;
	herdr:worktree.open)
		path=$(prompt_line 'Open worktree path')
		[ -n "$path" ] || exit 0
		exec "$herdr" worktree open --workspace "$workspace_id" --path "$path" --focus
		;;
	herdr:worktree.remove)
		require_workspace
		exec "$herdr" worktree remove --workspace "$workspace_id"
		;;
	herdr:tab.create)
		exec "$herdr" tab create --workspace "$workspace_id" --focus
		;;
	herdr:tab.rename)
		require_tab
		label=$(prompt_line 'Rename tab' "$tab_label")
		[ -n "$label" ] || exit 0
		exec "$herdr" tab rename "$tab_id" "$label"
		;;
	herdr:tab.previous)
		focus_relative_tab previous
		;;
	herdr:tab.next)
		focus_relative_tab next
		;;
	herdr:tab.pick)
		target=$(pick_tab)
		[ -n "$target" ] || exit 0
		exec "$herdr" tab focus "$target"
		;;
	herdr:tab.close)
		require_tab
		exec "$herdr" tab close "$tab_id"
		;;
	herdr:pane.rename)
		require_pane
		label=$(prompt_line 'Rename pane')
		[ -n "$label" ] || exit 0
		exec "$herdr" pane rename "$focused_pane_id" "$label"
		;;
	herdr:pane.rename.clear)
		require_pane
		exec "$herdr" pane rename "$focused_pane_id" --clear
		;;
	herdr:pane.read)
		require_pane
		exec "$herdr" pane read "$focused_pane_id" --source recent --lines 200 --format ansi --ansi
		;;
	herdr:pane.focus.left|herdr:focus.left)
		require_pane
		exec "$herdr" pane focus --pane "$focused_pane_id" --direction left
		;;
	herdr:pane.focus.down|herdr:focus.down)
		require_pane
		exec "$herdr" pane focus --pane "$focused_pane_id" --direction down
		;;
	herdr:pane.focus.up|herdr:focus.up)
		require_pane
		exec "$herdr" pane focus --pane "$focused_pane_id" --direction up
		;;
	herdr:pane.focus.right|herdr:focus.right)
		require_pane
		exec "$herdr" pane focus --pane "$focused_pane_id" --direction right
		;;
	herdr:pane.cycle.next)
		focus_relative_pane next
		;;
	herdr:pane.cycle.previous)
		focus_relative_pane previous
		;;
	herdr:pane.swap.left)
		require_pane
		exec "$herdr" pane swap --pane "$focused_pane_id" --direction left
		;;
	herdr:pane.swap.down)
		require_pane
		exec "$herdr" pane swap --pane "$focused_pane_id" --direction down
		;;
	herdr:pane.swap.up)
		require_pane
		exec "$herdr" pane swap --pane "$focused_pane_id" --direction up
		;;
	herdr:pane.swap.right)
		require_pane
		exec "$herdr" pane swap --pane "$focused_pane_id" --direction right
		;;
	herdr:pane.split.right)
		require_pane
		exec "$herdr" pane split "$focused_pane_id" --direction right --focus
		;;
	herdr:pane.split.down)
		require_pane
		exec "$herdr" pane split "$focused_pane_id" --direction down --focus
		;;
	herdr:pane.zoom)
		require_pane
		exec "$herdr" pane zoom "$focused_pane_id" --toggle
		;;
	herdr:pane.close)
		require_pane
		exec "$herdr" pane close "$focused_pane_id"
		;;
	herdr:pane.resize.left)
		require_pane
		exec "$herdr" pane resize --pane "$focused_pane_id" --direction left --amount 0.05
		;;
	herdr:pane.resize.down)
		require_pane
		exec "$herdr" pane resize --pane "$focused_pane_id" --direction down --amount 0.05
		;;
	herdr:pane.resize.up)
		require_pane
		exec "$herdr" pane resize --pane "$focused_pane_id" --direction up --amount 0.05
		;;
	herdr:pane.resize.right)
		require_pane
		exec "$herdr" pane resize --pane "$focused_pane_id" --direction right --amount 0.05
		;;
	herdr:agent.previous)
		focus_relative_agent previous
		;;
	herdr:agent.next)
		focus_relative_agent next
		;;
	herdr:agent.pick)
		target=$(pick_agent)
		[ -n "$target" ] || exit 0
		exec "$herdr" pane focus --pane "$target"
		;;
	shell:*)
		run_in_focused_cwd "${action#shell:}"
		;;
	*)
		clear_screen
		printf 'Unknown action: %s\n' "$action"
		sleep 1
		;;
esac
