# pi-pr-radar

Ambient PR awareness for pi-coding-agent.

## Features

- **Automatic polling**: Checks your open PRs every 2 minutes (configurable)
- **Footer status**: Compact display showing failing/pending/green PR counts
- **Keyboard shortcut**: `alt+p` opens the "worst" PR (failing first, then pending, then newest green)
- **Command**: `/prs` lists all open PRs with status glyphs
- **Graceful degradation**: Silently disables when gh unavailable, not authenticated, or offline

## Usage

The extension activates automatically when pi starts in a git repository. It:

1. Polls `gh pr list --author @me --state open` in the current repo (or configured repos)
2. Classifies each PR based on `statusCheckRollup`:
   - **Failing**: Any required/normal check failed (`✗`)
   - **Pending**: Checks running/queued (`●`)
   - **Green**: All checks passed (`✓`)
   - **Unknown**: No status available (`?`)
3. Displays a footer segment like `PR ✗2 ●1 ✓3` (hidden when zero PRs or gh unavailable)

### Keybinding

- **`alt+p`**: Opens the worst PR in your default browser (macOS `open` command)
  - Priority: failing → pending → newest green

### Command

- **`/prs`**: Lists all open PRs in the TUI with status glyphs

## Configuration

### Environment Variables

- **`PR_RADAR_INTERVAL_MS`**: Polling interval in milliseconds (default: `120000` = 2 minutes)
- **`PR_RADAR_REPOS`**: Comma-separated list of `owner/repo` to track across multiple repos
  - Default: current repo only
  - Example: `PR_RADAR_REPOS="artmsilva/agent-tools,artmsilva/exp-aviary"`

### Examples

```bash
# Poll every 5 minutes
export PR_RADAR_INTERVAL_MS=300000

# Track PRs across multiple repos
export PR_RADAR_REPOS="myorg/repo1,myorg/repo2,myorg/repo3"
```

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Git repository context
- macOS (for `open` command in `alt+p` shortcut)

## Degradation Behavior

The extension degrades gracefully when:

- **gh not installed**: Footer hidden, no errors
- **gh not authenticated**: Footer hidden, one-time notice
- **No git repo**: Footer hidden
- **Offline/network issues**: Footer hidden after first failure

No errors are logged after the initial detection, and the extension never crashes the TUI.

## Installation

Via pi package manager:

```bash
pi install github:artmsilva/agent-tools/packages/pi-pr-radar
```

Or clone and link locally:

```bash
git clone https://github.com/artmsilva/agent-tools.git
cd agent-tools/packages/pi-pr-radar
# Add to ~/.pi/agent/settings.json "packages" array
```

## License

MIT
