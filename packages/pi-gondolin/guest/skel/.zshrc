# pi-gondolin guest .zshrc — a secret-free port of the host zsh setup.
#
# What made it across: modern-CLI aliases, starship, zoxide, fzf, autosuggestions
# and fast-ish syntax highlighting (via apk packages instead of zinit), and the
# git-worktree helpers. What did NOT: anything that sources secrets (1Password
# `op inject`, ~/.config/zsh/.secrets.env), GUI tools (zed, cursor), or host-only
# infra (nono, ollama, claude session indexer).

# Interactive-only from here down.
[[ -o interactive ]] || return

# --- history --------------------------------------------------------------
HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt HIST_IGNORE_DUPS HIST_FIND_NO_DUPS SHARE_HISTORY INC_APPEND_HISTORY

# --- completion -----------------------------------------------------------
autoload -Uz compinit && compinit -d "$HOME/.cache/zcompdump" 2>/dev/null

# --- plugins (apk-installed; source defensively across layouts) ------------
_gondolin_source_first() {
  local f
  for f in "$@"; do [[ -r "$f" ]] && { source "$f"; return 0; }; done
  return 1
}
_gondolin_source_first \
  /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh \
  /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
_gondolin_source_first \
  /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh \
  /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
_gondolin_source_first \
  /usr/share/fzf/key-bindings.zsh /usr/share/fzf/completion.zsh 2>/dev/null
[[ -r /usr/share/fzf/completion.zsh ]] && source /usr/share/fzf/completion.zsh

# --- prompt + navigation --------------------------------------------------
command -v starship >/dev/null 2>&1 && eval "$(starship init zsh)"
command -v zoxide   >/dev/null 2>&1 && eval "$(zoxide init zsh)"

# --- aliases --------------------------------------------------------------
[[ -r "$HOME/.config/zsh/aliases.zsh" ]] && source "$HOME/.config/zsh/aliases.zsh"

# --- sandbox banner -------------------------------------------------------
if [[ -n "$GONDOLIN_SANDBOX" && -z "$GONDOLIN_QUIET" ]]; then
  print -P "%F{cyan}▟ gondolin sandbox%f — workspace at %F{yellow}/workspace%f, egress allowlisted."
fi
