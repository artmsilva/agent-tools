# Slack theme sync feasibility

_Checked 2026-08-14 against Slack 4.47.72 on macOS._

## Conclusion

Ghostty can generate the 10-color legacy string accepted by Slack's **Custom theme → Import theme** flow. Slack has no supported API for applying it.

The practical one-click implementation is macOS Accessibility automation of the four current color fields or legacy importer. The undocumented API does work with Slack Desktop's own authenticated session, but not with a modern Slack app token.

## Evidence

- Slack supports Light, Dark, and System color modes on desktop. The preference is device-specific. [Slack: Use dark mode](https://slack.com/help/articles/360019434914-Use-dark-mode-in-Slack)
- Slack supports custom per-workspace themes and syncs them across devices, but documents only manual editing, sharing, and importing through Preferences. [Slack: Change your Slack theme](https://slack.com/help/articles/205166337-Change-your-Slack-theme)
- Slack's documented managed desktop settings do not include appearance or custom-theme controls. [Slack: Manage desktop app configurations](https://slack.com/help/articles/11906214948755-Manage-desktop-app-configurations)
- Slack's documented Web API method catalog has no user-theme or user-preference setter. [Slack Developer Docs: Methods](https://docs.slack.dev/reference/methods/)
- The undocumented `users.prefs.set` endpoint still exists. The current modern OAuth token cannot call it: Slack reports that it requires classic `post`; `users.prefs.get` similarly requires classic `read`.
- A temporary authenticated Slack Desktop probe confirmed the current preference is named `ia_theme`. `users.prefs.set` accepts `name=ia_theme` and a JSON `value` containing `primary`, `highlight1`, `highlight2`, `important`, `brightness`, `sidebarInverted`, and `useCustomHex`. Each role supports an exact `custom` hex value. A no-op write of the existing value succeeded.
- Slack Desktop's own session uses a classic client credential with `identify,read,post,client,apps`. Reusing it outside the renderer also requires Slack's encrypted session cookie, making unattended direct API access a credential-extraction workflow rather than a normal OAuth integration.
- Slack retired creation of the broadly privileged legacy tester tokens that carried these scopes in 2020. [Slack: Legacy test token creation to retire](https://docs.slack.dev/changelog/2020-02-legacy-test-token-creation-to-retire/)
- [catppuccin/slack](https://github.com/catppuccin/slack) confirms the current importer accepts a 10-color legacy string, although Slack's redesign maps those values into its newer theme model.
- [mykeels/slack-theme-cli](https://github.com/mykeels/slack-theme-cli) is the closest prior CLI, but it patched Slack's Electron resources and its open issues report that it stopped working in Slack 4.0 and broke Slack 4.2.1. The installed Slack is 4.47.72.
- [a1ex-var1amov/mac-config](https://github.com/a1ex-var1amov/mac-config) generates matching Slack strings but deliberately stops at clipboard copy because there is no supported config file to write.
- The installed app stores desktop color-mode state privately in `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/storage/root-state.json`. That file controls Light/Dark/System, not the per-workspace custom palette shown in Slack Preferences.

## Options

| Option | Result | Risk | Recommendation |
|---|---|---:|---|
| Generate a Slack legacy string and automate Custom theme → Import theme | Applies a newly generated per-workspace Slack theme whenever Ghostty Random runs | Medium | **Use this for one-click sync** |
| Generate and copy the string | Reliable, but requires manual import | Low | Safe fallback |
| Use `users.prefs.set` with the existing modern user token | Blocked by retired classic `post` scope | High | Not viable |
| Call `users.prefs.set` inside an authenticated Slack Desktop renderer | Confirmed working with exact custom hex values | High | Requires Slack to run with remote debugging |
| Extract Slack Desktop's client credential and encrypted session cookie | Enables direct requests, but exposes a full user session and requires Keychain cookie decryption | Very high | Do not use for a theme switcher |
| Patch Slack.app like the old CLI | Breaks code signing and updates; old implementation has been broken since Slack 4.x | Very high | Do not use |

## Minimal implementation direction

1. Reuse `ghostty-theme-sync`'s derived Ghostty roles to emit Slack's 10-color legacy string.
2. Use macOS Accessibility automation to open Slack's active workspace preferences.
3. Navigate to **Appearance → Custom theme → Import theme**, paste the generated string, and apply it.
4. If Slack's UI cannot be located, copy the string to the clipboard and return a clear warning instead of clicking coordinates blindly.

This is unsupported UI automation, but it avoids modifying the signed Slack app or handling Slack session credentials.
