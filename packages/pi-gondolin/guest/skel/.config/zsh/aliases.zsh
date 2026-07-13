# pi-gondolin guest aliases — the modern-CLI subset of the host aliases.zsh,
# limited to tools installed in the guest (see config/packages.json).

# Modern CLI replacements
command -v bat   >/dev/null 2>&1 && alias cat='bat'
command -v eza   >/dev/null 2>&1 && { alias ls='eza'; alias ll='eza -la --git --icons'; alias la='eza -a --icons'; alias lt='eza --tree --level=2 --icons'; }
command -v dust  >/dev/null 2>&1 && alias du='dust'
command -v procs >/dev/null 2>&1 && alias ps='procs'
command -v delta >/dev/null 2>&1 && alias diff='delta'
# Note: fd/rg are used directly (incompatible flags with find/grep), not aliased.

# Safe delete: move into an in-guest trash dir instead of unlinking (matters
# because /workspace writes through to the host).
trash() {
  local d="$HOME/.local/share/Trash/files"
  mkdir -p "$d"
  mv -f -- "$@" "$d"/ 2>/dev/null || command rm -rf -- "$@"
}
alias rm='trash'

# Git shortcuts
alias co='git checkout'
alias gs='git status'
alias gwtl='git worktree list'
gpush() { git push origin "$(git branch --show-current)"; }

# Reminder: git gc / prune / worktree prune are refused by the sandbox guard.
