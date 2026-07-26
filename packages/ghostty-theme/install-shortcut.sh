#!/bin/bash
#
# install-shortcut.sh - Install "Ghostty Random Theme" as a Spotlight-accessible app
#
# Creates a macOS .app bundle via osacompile that:
#   1. Runs ghostty-theme --random
#   2. Shows a notification with the result
#
# Usage: ./install-shortcut.sh
# Uninstall: ./install-shortcut.sh --uninstall

set -euo pipefail

APP_NAME="Ghostty Random Theme"
INSTALL_DIR="$HOME/Applications"
APP_PATH="$INSTALL_DIR/$APP_NAME.app"

uninstall() {
    if [[ -d "$APP_PATH" ]]; then
        /bin/rm -rf "$APP_PATH"
        echo "Removed $APP_PATH"
    else
        echo "Not installed: $APP_PATH not found"
    fi
}

install() {
    # Check ghostty-theme is available
    if ! command -v ghostty-theme &>/dev/null; then
        echo "Error: ghostty-theme not found in PATH" >&2
        echo "Install it first: cp ghostty-theme ~/.local/bin/" >&2
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"

    # Remove existing version if present
    [[ -d "$APP_PATH" ]] && /bin/rm -rf "$APP_PATH"

    # Write AppleScript to temp file to avoid quoting hell
    local tmpscript
    tmpscript=$(mktemp /tmp/ghostty-shortcut.XXXXXX)
    cat > "$tmpscript" << 'APPLESCRIPT'
set homePath to POSIX path of (path to home folder)
set shellCmd to "export PATH=" & homePath & ".local/bin:/Applications/Ghostty.app/Contents/MacOS:/usr/bin:/bin:$PATH && ghostty-theme --random"
set result to do shell script shellCmd
display notification result with title "Ghostty Theme"
APPLESCRIPT

    osacompile -o "$APP_PATH" "$tmpscript"
    /bin/rm -f "$tmpscript"

    echo "Installed: $APP_PATH"
    echo "Trigger via Spotlight: search for \"$APP_NAME\""
}

case "${1:-}" in
    --uninstall)
        uninstall
        ;;
    --help|-h)
        echo "Usage: $0 [--uninstall]"
        echo ""
        echo "Installs '$APP_NAME' to ~/Applications/"
        echo "Trigger from Spotlight by typing '$APP_NAME'"
        ;;
    *)
        install
        ;;
esac
