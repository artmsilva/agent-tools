# Ghostty Theme Selector

Part of [agent-tools](https://github.com/artmsilva/agent-tools).

Interactive theme selector for [Ghostty](https://ghostty.org/) terminal with live preview.

## Features

- Fuzzy search through 400+ Ghostty themes using fzf
- **Live preview** - terminal reloads in real-time as you browse (with debouncing)
- Color palette preview matching Ghostty's native format
- Sample code preview with syntax highlighting
- Config backup/restore on cancel or interrupt (Ctrl+C)
- Theme validation for direct set mode
- Generates missing Pi themes from Ghostty's complete catalog
- Applies matching Herdr built-ins or an accessible custom Herdr palette

## Requirements

- macOS (uses AppleScript for config reload)
- [Ghostty](https://ghostty.org/) terminal
- [fzf](https://github.com/junegunn/fzf) - fuzzy finder
- [bat](https://github.com/sharkdp/bat) - syntax highlighting (optional, for code preview)
- Python 3 - companion theme generation (standard library only)

```bash
brew install fzf bat
```

**Note:** You may need to grant Accessibility permissions for live reload to work.
Go to **System Settings > Privacy & Security > Accessibility** and add Ghostty or Terminal.

## Installation

Install both executables into a directory in your PATH:

```bash
install -m 755 ghostty-theme ghostty-theme-sync ~/.local/bin/
# or
sudo install -m 755 ghostty-theme ghostty-theme-sync /usr/local/bin/
```

## Usage

```bash
ghostty-theme                    # Interactive selection with live preview
ghostty-theme <name>             # Set theme directly (validates theme exists)
ghostty-theme --current, -c      # Show current theme
ghostty-theme --random, -r       # Set a random theme
ghostty-theme --sync             # Generate Pi catalog; sync current theme to Pi/Herdr
ghostty-theme --check            # Validate generated themes and Herdr config
ghostty-theme --help, -h         # Show help message
```

### Examples

```bash
ghostty-theme "Dracula"
ghostty-theme "Catppuccin Mocha"
ghostty-theme --random           # Surprise me
```

## Spotlight Integration

Set a random theme from Spotlight without opening a terminal:

```bash
./install-shortcut.sh           # Install the app
./install-shortcut.sh --uninstall  # Remove it
```

Then type **"Ghostty Random"** in Spotlight and hit Enter. A notification shows the selected theme.

## How It Works

1. Lists all available Ghostty themes via `ghostty +list-themes`
2. Presents them in fzf with a color palette and code preview
3. As you navigate, updates your config and triggers reload (debounced at 150ms)
4. Press **Enter** to confirm, **Esc** or **Ctrl+C** to cancel and restore original
5. On confirmation, hot-reloads Pi's `Ghostty Current` theme and updates Herdr
6. When Herdr has no matching built-in, writes a derived `[theme.custom]` palette

## Companion themes

Run once after installation or a Ghostty update:

```bash
ghostty-theme --sync
```

Pi receives one named JSON theme for every Ghostty theme without an existing normalized match. A stable `~/.pi/agent/themes/Ghostty Current.json` theme is rewritten on selection so running Pi sessions hot-reload; restart Pi once after setup to select it. Herdr reuses matching built-ins; unmatched themes are converted into its active custom palette because Herdr does not support multiple named custom themes.

The converter preserves source hues while deriving semantic roles and surface hierarchy. It targets WCAG contrast ratios of 7:1 for primary text, 4.5:1 for secondary/semantic text, and 3:1 for borders. See [WCAG contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Configuration

The script modifies your Ghostty config. Default location:

```
~/Library/Application Support/com.mitchellh.ghostty/config
```

Override with:

```bash
GHOSTTY_CONFIG=/path/to/config ghostty-theme
```

## Preview

The preview panel shows:
- Theme name and file path
- 16-color palette with auto-contrasting labels
- Sample Zig code with syntax highlighting (requires `bat`)
