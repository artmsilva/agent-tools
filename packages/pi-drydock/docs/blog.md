# Davit is the window, not the wall

*How I would use Apple’s container stack to sandbox Pi without moving Pi—or its credentials—into the guest.*

Davit looks like the missing desktop for local agent sandboxes. It shows containers, live resource use, logs, files, networks, images, and an interactive terminal in a native macOS app. That makes it useful. It does not make it the sandbox.

The security boundary comes from Apple’s [`container`](https://github.com/apple/container) platform. Davit is an operator UI over that platform: it links Apple’s `ContainerAPIClient` and talks directly to `container-apiserver` over XPC, following the same path as the CLI. It can help a human inspect and stop an agent workload, but it does not intercept Pi tools, constrain mounts, broker secrets, or enforce network policy. ([Davit README](https://github.com/wouterdebie/davit/blob/main/README.md), [backend](https://github.com/wouterdebie/davit/blob/main/Sources/ContainerStack/Backend.swift))

That distinction determines the architecture.

## Keep Pi on the host

Pi should keep running on macOS. Provider OAuth, API keys, sessions, UI state, themes, and host integrations remain there. Only its file and shell operations cross the boundary:

```text
Pi on macOS
  -> pi-drydock tool overrides + security policy
  -> Apple container runtime
  -> copied workspace inside the guest

Davit -> optional inspection and emergency controls
```

Pi already supports this pattern. Extensions can override the built-in file and shell tools with remote operations, while the model loop and credentials stay outside the guest. Pi’s own security guidance recommends OS, VM, or container isolation for untrusted code; project trust is not a sandbox. ([Pi containerization](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/containerization.md), [Pi security](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md))

The independent package is [`pi-drydock`](../README.md). It owns one platform contract—Apple’s `container`—plus its own threat model, lifecycle, and tests. [`pi-gondolin`](../../pi-gondolin/README.md) is useful prior art for tool routing, path rewriting, guest setup, egress, and worktree hazards, but it is neither a dependency nor a shared backend.

Apple’s runtime is interesting because every Linux container runs in its own lightweight virtual machine on Apple silicon. That is a stronger process boundary than a conventional shared-kernel container and uses OCI images. It is also young, limited to supported Apple-silicon/macOS combinations, and still evolving. ([Apple technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md), [Apple README](https://github.com/apple/container/blob/main/README.md))

## Dotfiles are code, not decoration

A fresh agent guest needs fewer personal files than a fresh interactive laptop.

Bake the deterministic toolchain: shell, git, CA roots, Node, Pi-compatible tools, `rg`, `fd`, and build dependencies. Bake a minimal, secret-free `.zshrc`, a few aliases, a fallback prompt, and safe git defaults. Generate disposable HOME, cache, temp, and sanitized Pi settings at launch.

Copy or mount only reviewed task instructions. Pi skills and extensions are executable authority, not inert preferences. Project `.pi` resources and `AGENTS.md` can also carry untrusted instructions, so their inclusion should be an explicit policy decision.

Never project the host’s full HOME. In particular, keep these outside:

- `~/.pi/agent/auth.json`, sessions, trust decisions, MCP OAuth state, and telemetry databases;
- `.npmrc`, cloud configs, SSH/GPG keys and agents, browser profiles, keychains, and 1Password material;
- credential helpers, signing configuration, host-path includes, and shell startup hooks;
- host Pi themes and UI settings, because guest tools do not need them.

Official Dev Containers and Codespaces guidance treats dotfile installers as arbitrary code and separates personal setup from project tooling. For an unattended agent, the safer default is stricter: curated files baked into a pinned image, no network-time dotfile bootstrap. ([Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers#_personalizing-with-dotfile-repositories), [GitHub Codespaces](https://docs.github.com/en/codespaces/setting-your-user-preferences/personalizing-github-codespaces-for-your-account#dotfiles))

## Mount less; export a patch

A VM does not make a writable host mount safe. If `/Users/me/Github/project` is mounted read-write, guest writes still change the host project.

The first Apple-container experiment should copy the workspace into the guest, run with no secrets and no external network, then export a patch or selected artifacts for host review. A disposable worktree can become an opt-in performance trade-off later. Shared git metadata should not be mounted by default; regex guards around `git gc` and `git push` are defense in depth, not a filesystem boundary.

Network controls need the same skepticism. Apple’s internal network mode removes ordinary external NAT, but it is not a domain allowlist and an open issue reports host-gateway reachability from internal networks. Online work needs a separate, fail-closed egress broker with exact host and port rules, private-range denial, DNS-rebinding checks, audit logs, and destination-bound credentials. ([Apple network command](https://github.com/apple/container/blob/main/Sources/ContainerCommands/Network/NetworkCreate.swift), [issue #1320](https://github.com/apple/container/issues/1320))

## The smallest honest spike

Start with `bash`, not backend parity:

1. Pin a prebuilt image and tested Apple `container` release.
2. Launch as non-root with a read-only root filesystem, tmpfs HOME, dropped capabilities, and CPU/RAM/PID/time limits.
3. Copy source in; expose no host HOME, sockets, git metadata, provider auth, or package-manager credentials.
4. Disable external egress.
5. Run one command and export a patch.
6. Prove five things in one integration check: the guest can edit copied source, cannot read host HOME, cannot reach the internet, cannot mutate the original worktree, and produces a patch that applies.

That boundary spike now passes on Apple `container` 1.1.0. It also found two practical constraints: `container copy` cannot populate a live tmpfs mount, so Drydock streams files through `container exec`; and `--cap-drop ALL` prevents even UID 0 from repairing ownership, so files enter as the final unprivileged UID. The [captured run](./spike-2026-07-26.md) records the exact environment and limits.

Only then add file-operation adapters, reviewed skill projection, and brokered egress. Davit comes last as optional visibility—not as a dependency and never as part of the trusted computing base.

This is narrower than “run Pi in a container,” on purpose. The model loop does not need the workspace’s authority, and the workspace does not need the model provider’s credentials. Splitting those responsibilities leaves fewer secrets to hide and fewer dotfiles to reproduce.

The full cited decision record is in [the research report](./research.md). An [interactive architecture brief](./brief.html) presents the same recommendation as a filterable decision surface.
