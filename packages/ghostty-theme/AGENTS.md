# Package instructions

## Scope

macOS CLI pair (`ghostty-theme` bash, `ghostty-theme-sync` python3 stdlib-only)
for interactive Ghostty theme selection with live preview and Pi/Herdr sync.

## Validation

```bash
bash -n ghostty-theme
python3 -c 'compile(open("ghostty-theme-sync").read(), "ghostty-theme-sync", "exec")'
```

## Guardrails

- No test suite exists — syntax-check both scripts (above) after any edit;
  `ghostty-theme --check` validates *generated themes*, not script syntax.
- `ghostty-theme-sync` is stdlib-only Python (no pip deps) — keep it that way.
- macOS-only: both scripts assume Darwin (AppleScript reload, `uname` guard in
  `ghostty-theme`); don't add cross-platform branches without a real need.
- Config edits must go through the existing backup/restore-on-cancel path
  (`$CONFIG.bak`, trap-based cleanup) — don't write `$CONFIG` directly.
- `PI_REQUIRED` in `ghostty-theme-sync` must match Pi's theme schema fields —
  changing generated theme keys without updating this set breaks validation.
