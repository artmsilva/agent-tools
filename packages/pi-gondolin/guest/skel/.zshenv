# pi-gondolin guest .zshenv — loaded for every shell (login + non-login).
# Keep this minimal; the interactive goodies live in .zshrc.

export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export EDITOR="vi"
export PAGER="less"
export LANG="${LANG:-C.UTF-8}"
