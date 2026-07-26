# Pi inside Apple `container`

## Recommendation

Run one long-lived, guest-local Pi container, then attach from the host with:

```sh
container exec --interactive --tty --workdir /workspace <name> pi
```

No `sshd` is needed. `--interactive` keeps stdin open; `--tty` allocates a TTY. Apple also exposes `--env`, UID/GID, workdir, and ulimits on `exec`. [`container exec --help`, Apple `container` 1.1.0]

## Terminal behavior

Pi needs terminal escape sequences, not SSH. Its TUI uses the Kitty keyboard protocol where available. Host terminal mappings should therefore pass through the exec stream. One exception: Pi's macOS-only modifier fallback works only when Pi runs on the same Mac as Terminal.app; guest Pi is Linux, so rely on a Kitty-capable host terminal or explicit key mappings. Clipboard/image paste and external-editor behavior also become guest capabilities, not host integrations. [Pi `docs/terminal-setup.md`; `docs/usage.md`]

Treat resize, signals, raw mode, modified Enter, Ctrl+C, and reconnect after host-terminal loss as acceptance tests. Apple help establishes TTY/stdin allocation but does not promise every TUI sequence. [`container exec --help`]

## Image and runtime

Apple defaults to `linux/arm64`; `--platform`, `--arch`, resource limits, read-only root, tmpfs, capability drops, and custom networks are available. [`container run --help`]

Pi 0.81.1 requires Node `>=22.19.0`. Its own container recipe uses `node:24-bookworm-slim` plus `bash`, CA certificates, Git, and ripgrep, then installs Pi globally. Prefer that Debian shape over Alpine: Pi falls back to `sh`, but Bash is its first Unix shell choice, and the Debian recipe is the maintained reference. [Pi `package.json#engines`; `docs/containerization.md`; `dist/utils/shell.js#getShellConfig`]

Persist only guest-owned state and workspace volumes. A read-only root requires writable `/tmp`, Pi state, sessions, package cache, and workspace mounts.

## Pi state and credentials

Default guest paths:

- config/resources: `~/.pi/agent/`
- credentials: `~/.pi/agent/auth.json`
- settings/models/trust: `settings.json`, `models.json`, `trust.json` there
- sessions: `~/.pi/agent/sessions/`
- project settings/resources: `<cwd>/.pi/`

`PI_CODING_AGENT_DIR` relocates agent state. Session precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir`; `--no-session` disables persistence. OAuth tokens in `auth.json` auto-refresh. [Pi `dist/config.js#getAgentDir/getAuthPath/getSessionsDir`; `docs/providers.md`; `docs/settings.md`; `docs/sessions.md`]

Do **not** mount host `~/.pi/agent`: Pi explicitly says this exposes host auth and sessions. Also avoid host HOME/workspace bind mounts, `--ssh`, inherited credential environment variables, and published host sockets. Copy source in and reviewed changes out. A guest compromise then reaches only guest-local tokens and files. [Pi `docs/security.md`; `docs/containerization.md`; Apple `container run --help`]

## Later model access under default deny

Whole-Pi containment creates one hard constraint: Pi and its shell tools share the guest network namespace. Direct provider egress therefore grants tools the same path.

Viable later patterns, strongest first:

1. **Guest-local model server**: no network interface required; configure Pi through `models.json` or llama.cpp localhost support.
2. **Credentialless inference broker**: expose only one broker endpoint; broker holds provider credentials, validates destination/method, and rate-limits. Pi supports custom OpenAI/Anthropic-compatible `baseUrl`s and HTTP proxy settings.
3. **Short-lived guest token plus strict allowlist**: simplest, but shell can read and reuse the token; acceptable only as a weaker mode.

Keep the current link-down boundary as default. An Apple `--internal` network is host-only, not no-network; the existing spike reached the host gateway before explicitly lowering `eth0`. Any broker mode needs regression tests for direct IP, DNS, host gateway, metadata endpoints, and network restoration. [Pi `docs/models.md`; `docs/llama-cpp.md`; `docs/providers.md`; `docs/settings.md`; Apple `container network create --help`; `packages/pi-drydock/docs/spike-2026-07-26.md`]
