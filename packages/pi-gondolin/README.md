# pi-gondolin

Run [pi](https://github.com/earendil-works)'s file and shell tools inside a
[Gondolin](https://earendil-works.github.io/gondolin/) micro-VM — a real sandbox
with **locked network egress**, not the wide-open upstream example.

The upstream tool-routing example mounts your cwd and nothing else: no packages,
leaked host `HOME`, dead skill paths, unrestricted network, and it will happily
`git gc` your shared worktrees into oblivion. This package fixes all of that and
adds your dotfiles.

## What you get

- **Locked egress + interactive approval.** Every outbound host is checked
  against an allowlist. An unknown host **pauses and asks you**: _allow once_,
  _allow & save_, or _deny_. Both the HTTP layer and DNS/IP layer are gated, and
  a host is prompted for at most once (concurrent requests share one prompt).
- **GitHub token injection.** Your token is injected host-side only for GitHub
  hosts. The guest sees an opaque placeholder — never the real token.
- **Read-only skills.** `~/.agents/skills` and `~/.pi/agent/skills` are mounted
  read-only, and advertised skill paths in the system prompt are rewritten to
  their guest locations, so skills actually resolve inside the VM.
- **No host leakage.** `HOME=/root`; host identity/location env vars
  (`HOME`, `SSH_AUTH_SOCK`, host `PATH`, `/Users/...` values, …) are stripped
  before they reach the guest shell. The rest of `$HOME` is **not** mounted, so
  SSH keys, `pi`'s `auth.json`, and `.secrets.env` stay on the host.
- **git-worktree safety.** For a linked worktree the shared `.git` common dir is
  mounted (so git works), `gc.auto=0` is set, and `git gc` / `git prune` /
  `git worktree prune|remove|move` are **refused** inside the guest so they can't
  corrupt your live host worktrees.
- **Your zsh, in the box.** A secret-free port of your setup: starship, zoxide,
  fzf, autosuggestions + syntax highlighting (via apk, not zinit), and the
  modern-CLI aliases (`bat`, `eza`, `rg`, `fd`, `dust`, `procs`, `delta`, and a
  safe `trash`). Your live `starship.toml` is synced in.
- **Opt-in in-VM browser.** `--gondolin-browser` provisions Chromium +
  `agent-browser`. Sites the browser visits hit the same egress prompt.

## Install

Requires Node ≥ 23.6 and QEMU (`brew install qemu`). A container runtime
(Docker/Podman) is recommended so the installer can bake the full-toolchain
image.

```sh
cd packages/pi-gondolin
./scripts/install.sh          # add --no-image to skip the bake
```

This installs deps, symlinks the package into `~/.pi/agent/extensions/gondolin`
(backing up any existing extension), and — if a container runtime is present —
bakes the full-toolchain image (`pi-gondolin:latest`, a few minutes).

### Opt-in

The sandbox is **off by default** — a normal `pi` session is unaffected (no VM,
no tool routing, no prompt changes; pi uses its own host tools). Enable it
per-launch:

```sh
pi --gondolin                 # run pi's file/shell tools inside the micro-VM
GONDOLIN=1 pi                 # same, via env
pi --gondolin --gondolin-browser   # + in-VM browser
```

When off, `/gondolin` just prints how to turn it on. Run ad-hoc without
installing: `pi --gondolin -e /path/to/agent-tools/packages/pi-gondolin`.

### Two tiers (why the bake matters)

The stock Gondolin image has a fixed ~261MB rootfs with only ~86MB free and no
`resize2fs`, so the full toolchain does **not** fit at runtime. Hence:

| | Image | Toolset |
| --- | --- | --- |
| **Baked** (recommended, auto-detected) | `pi-gondolin:latest` | git, ripgrep, fd, **zsh + starship + all the darlings**, node, gh |
| **Stock fallback** (no bake) | `alpine-base:latest` | a minimal set (`git`, `rg`, `fd`, `jq`, `curl`, `bash`) installed at boot |

The extension prefers a baked `pi-gondolin:latest` (or `pi-gondolin-browser:latest`)
via `listImageRefs()`; set `GONDOLIN_DEFAULT_IMAGE` to override. On the stock
image it installs the minimal set with `apk` at boot and tells you to bake.

## Commands

| Command | What it does |
| --- | --- |
| `/gondolin` | VM + sandbox status (id, mounts, allowlist counts, token, browser) |
| `/gondolin-allowlist` | Show default / saved / session allow patterns |
| `/gondolin-allow HOST` | Permanently allow a host pattern |
| `/gondolin-unallow HOST` | Remove a saved host pattern |
| `/gondolin-timing` | Show the boot timeline (ms since `pi` was invoked) |

The agent can also call the **`request_network_access(hosts, reason)`** tool to
ask you for access proactively before running a command.

## The allowlist

- **Defaults** ship in [`config/allowlist.default.json`](./config/allowlist.default.json)
  (Alpine CDN, GitHub, npm/PyPI/crates/Go registries).
- **Your saves** persist to `~/.pi/agent/gondolin/allowlist.json`.
- **Patterns:** exact (`api.github.com`), bare domain (`github.com` — matches its
  subdomains), or wildcard (`*.githubusercontent.com`).

In headless modes (no interactive UI), unknown hosts **fail closed**.

## Browser profile

Chromium is too big for the stock rootfs, so bake the browser image first, then
enable the profile:

```sh
./scripts/build-image.sh --browser     # -> pi-gondolin-browser:latest
pi --gondolin-browser                   # or: GONDOLIN_BROWSER=1 pi
```

The browser image bakes `chromium` (musl-native) + node; the extension installs
`agent-browser` at boot and points it at the apk Chromium
(`CHROME_BIN=/usr/bin/chromium-browser`), headless (≈6G RAM). Load workflows
in-guest with `agent-browser skills get core`. Sites the browser visits hit the
same egress prompt.

> Experimental: `agent-browser` in a headless musl micro-VM works over CDP, but
> there's no display/GPU. If Chromium won't launch, confirm `chromium-browser
> --headless --version` runs in the guest and see `agent-browser skills get core`.

## Baking images

`install.sh` bakes `pi-gondolin:latest` automatically when a container runtime is
present. To (re)bake manually:

```sh
./scripts/build-image.sh              # full CLI toolchain  -> pi-gondolin:latest
./scripts/build-image.sh --browser    # + chromium          -> pi-gondolin-browser:latest
```

Baking sizes the rootfs at build time (2GB, or 4GB for the browser image) so the
full toolchain fits and boots are instant/offline. The extension auto-detects the
tags. Edit [`image/build.jsonc`](./image/build.jsonc) to customize packages —
keep `linux-virt` + `rng-tools` + `e2fsprogs` in `rootfsPackages` (linux-virt
provides the virtio modules; without it the guest can't find `/dev/vda`).

## Layout

```
index.ts              extension entry: VM lifecycle, tools, commands, prompt rewrite
src/allowlist.ts      allowlist store + single-flight interactive approval
src/http-gate.ts      createHttpHooks wiring (egress gates + token injection)
src/mounts.ts         VFS mounts (workspace, shared .git, skills, skel) + rewrites
src/provision.ts      boot provisioning (CA trust, apk, git hardening, dotfiles)
src/guard.ts          git gc/prune guard + host-env sanitizer
src/tools.ts          routed read/write/edit/bash/grep/find/ls ops
src/paths.ts          host<->guest path mapping
config/               default allowlist + apk package lists
guest/skel/           dotfiles copied into /root at boot
image/build.jsonc     custom image build config
scripts/              install.sh, build-image.sh
```

## Startup

When enabled (`--gondolin`), the VM boots **in the background** on
`session_start`, so it never blocks pi from rendering the prompt — you can read and type immediately. The routed tools
`await` VM readiness lazily, so the only wait you might notice is the *first*
file/shell tool call if the VM isn't warm yet.

Provisioning is kept lean: the MITM CA is trusted by appending to the cert
bundle (`/etc/ssl/cert.pem` symlinks to it) instead of the ~340ms
`update-ca-certificates` rehash; dotfiles + starship + the shell probe all ride
one guest exec. What's left is Gondolin's inherent first-exec/guest-readiness
warmup (~0.5–2.5s, memory-independent) — now off the render critical path.

### Boot telemetry

The extension records how long startup takes, measured in ms since the `pi`
process began (`performance.now()`), across these milestones:

```
extension_loaded → session_start → vm_boot_start → vm_created → provisioned → vm_ready → first_prompt
```

- `/gondolin-timing` prints the timeline (per-step deltas + totals).
- The "VM ready" notification shows VM-boot ms and total-since-pi-start ms.
- Every boot appends a JSONL record to `~/.pi/agent/gondolin/telemetry.jsonl`:

  ```json
  {"ts":"…","event":"boot","totalMs":3829,"renderMs":31,"vmBootMs":3514,
   "marks":[{"name":"extension_loaded","atMs":246,"deltaMs":246}, …],
   "image":"pi-gondolin:latest","browser":false}
  ```

  `renderMs` = extension-load → session-start (≈ pi rendering the prompt);
  `vmBootMs` = VM.create → sandbox usable. Analyze trends with e.g.
  `jq -c 'select(.event=="boot") | {ts,totalMs,vmBootMs}' ~/.pi/agent/gondolin/telemetry.jsonl`.

Disable with `GONDOLIN_TELEMETRY=0`.

> Tip: provisioning (CA trust + `update-ca-certificates` + dotfiles) tends to
> dominate boot even on a baked image — the timeline makes that obvious.

## Security notes

- The sandbox constrains the **agent's** tools, not `pi` itself. `pi`'s own LLM
  API calls go out on the host.
- Secret injection means the guest can *use* your GitHub token against GitHub
  without ever seeing it — but a compromised guest could still exfiltrate data to
  any host **you approve**. Approve deliberately.
- `blockInternalRanges` stays on, so the guest can't reach host-local/RFC1918
  addresses even if a hostname resolves there.

## License

MIT. See [`LICENSE`](./LICENSE).
