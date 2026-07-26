# `pi-drydock`: Apple `container` sandboxing with Davit

## Decision

Apple's `container` is a credible **macOS 26 / Apple-silicon sandbox runtime** for Pi tool execution: each Linux container gets its own lightweight VM, and host data is present only when explicitly mounted. Davit is a useful native operator UI and API-client example, **not the runtime or security boundary**. Build this as `pi-drydock`: an independent package with its own identity, Apple-platform contract, threat model, lifecycle, and tests.

Prefer **host Pi + sandboxed tools**. Pi then keeps provider OAuth/API credentials and sessions on the host while `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `!` execute in the guest. Pi explicitly recommends OS/VM/container isolation and documents this tool-routing pattern; project trust alone is not a sandbox. [Pi security](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md) [Pi containerization](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/containerization.md)

## 1. Davit: contribution and boundary

Davit is a SwiftUI management application for Apple's platform. It links `ContainerAPIClient` and communicates with `container-apiserver` directly over XPC—the same path as the `container` CLI—covering lifecycle, logs, stats, files, exec, images, volumes, and networks. It does not shell out to the CLI. [Davit README](https://github.com/wouterdebie/davit/blob/main/README.md) [Package.swift](https://github.com/wouterdebie/davit/blob/main/Package.swift) [Backend.swift](https://github.com/wouterdebie/davit/blob/main/Sources/ContainerStack/Backend.swift)

**Useful:** optional human inspection/control; evidence that headless XPC automation is possible; models for service bootstrap, version detection, container recreation, log streaming, and file copy.

**Not provided:** a hypervisor/runtime, Pi tool interception, filesystem policy, egress allowlisting, secret brokering, safe dotfile projection, or git-worktree protection. Davit must not be in the trusted computing base. Its exact pins to matching `container`/Containerization releases and comment that client and daemon ship in lockstep also warn against making their unstable Swift API the first integration seam. Start with the supported `container` CLI; consider direct `ContainerAPIClient` only after behavior stabilizes. [Package.swift](https://github.com/wouterdebie/davit/blob/main/Package.swift)

## 2. Suitability and limitations of Apple `container`

Apple's platform runs each container in a separate lightweight VM using Virtualization.framework, with a minimal guest and OCI-compatible images. `container-apiserver` and XPC helpers manage images, networking, and one runtime helper per container. This is materially stronger isolation than ordinary same-kernel containers and fits unattended agent execution. [Technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md) [Containerization README](https://github.com/apple/containerization/blob/main/README.md)

Material constraints:

- **Platform:** Apple silicon and supported macOS 26; older macOS networking has significant limitations and is unsupported. [README](https://github.com/apple/container/blob/main/README.md) [Technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md#macos-15-limitations)
- **Host mounts remain host authority:** `--volume`/`--mount` shares host paths; writes can modify them despite the VM boundary. [How-to](https://github.com/apple/container/blob/main/docs/how-to.md#share-host-files-with-your-container)
- **Network policy is too coarse:** `network create --internal` selects host-only rather than NAT networking, but it is not a per-domain allowlist or secret-aware proxy. [NetworkCreate.swift](https://github.com/apple/container/blob/main/Sources/ContainerCommands/Network/NetworkCreate.swift) An open Apple-repo report says the host gateway remains reachable from `--internal` networks, so this mode alone must not be treated as host isolation. [Issue #1320](https://github.com/apple/container/issues/1320)
- **Resource behavior:** CPU/RAM limits exist, but freed guest memory is not currently ballooned back to macOS; many heavy agents may require restarts. [How-to](https://github.com/apple/container/blob/main/docs/how-to.md#configure-memory-and-cpus-for-your-containers) [Technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md#releasing-container-memory-to-macos)
- **Young interfaces:** the project documents active development; Davit's lockstep pins demonstrate client/API churn. Pin tested releases and feature-detect flags. [Apple README](https://github.com/apple/container/blob/main/README.md) [Davit Package.swift](https://github.com/wouterdebie/davit/blob/main/Package.swift)
- **No complete agent policy layer:** rootfs read-only, capability drops, CPU/memory, user, mounts, and networks are useful primitives, but domain egress, credential mediation, tool coverage, and export review remain ours. [Command reference](https://github.com/apple/container/blob/main/docs/command-reference.md#container-run)

## 3. Minimal architecture: independent `pi-drydock`

`pi-drydock` should be a separate package inside `agent-tools`, not a `pi-gondolin` backend, shared runtime abstraction, or compatibility layer. It owns one platform: Apple's `container`. Davit remains an optional companion UI. [Pi remote operations](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#remote-execution)

```text
Pi on host
  -> pi-drydock tool overrides / path policy / prompt rewrite
  -> DrydockController { launch, exec, copyIn, exportPatch, stop }
  -> Apple `container` CLI (`create/start/exec/cp/delete`)

Davit -> optional inspection and emergency controls
```

The package creates a pinned image, non-root user, resource limits, dropped capabilities, read-only root, explicit copy-in/export, and internal/no-egress network. It can use Pi's `create*Tool(...operations)` contracts directly without importing another sandbox package.

`pi-gondolin` remains useful local prior art because it demonstrates tool overrides, path rewriting, curated guest setup, skill projection, egress controls, telemetry, and worktree hazards. Those are requirements to independently validate—not code or identity to inherit. [README](https://github.com/artmsilva/agent-tools/blob/main/packages/pi-gondolin/README.md) [index.ts](https://github.com/artmsilva/agent-tools/blob/main/packages/pi-gondolin/index.ts)

Three prior-art warnings become `pi-drydock` design constraints:

1. Pi warns that overriding built-ins does **not** sandbox arbitrary custom tools. Start with an explicit reviewed tool allowlist and require sandbox-aware adapters for every active mutating/network tool. [Pi containerization](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/containerization.md)
2. Forward guest environment variables from an allowlist, never a denylist; arbitrary host variables must not cross the boundary. Existing [`guard.ts`](https://github.com/artmsilva/agent-tools/blob/main/packages/pi-gondolin/src/guard.ts) shows why this needs an explicit fresh design.
3. Regex git-command guards are defense in depth, not a boundary. Avoid shared git metadata and live host-workspace mounts by default. [mounts.ts](https://github.com/artmsilva/agent-tools/blob/main/packages/pi-gondolin/src/mounts.ts) [guard.ts](https://github.com/artmsilva/agent-tools/blob/main/packages/pi-gondolin/src/guard.ts)

## 4. Pi and dotfile projection

Official Dev Containers/Codespaces guidance treats dotfiles as personalization installed into a fresh environment and warns that installers can execute arbitrary code; project-wide tooling belongs in the image/dev-container configuration, not personal dotfiles. [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers#_personalizing-with-dotfile-repositories) [GitHub Codespaces](https://docs.github.com/en/codespaces/setting-your-user-preferences/personalizing-github-codespaces-for-your-account#dotfiles)

| Asset | Action | Reason |
|---|---|---|
| Node, Pi-compatible toolchain, git, shell, CA bundle, `rg`/`fd`/build tools | **Bake** | Reproducible, offline-capable, no startup installers. |
| Minimal secret-free `.zshrc`, aliases, fallback `starship.toml`, git safety defaults | **Bake** | Convenience only; no host paths, token lookup, launchers, or auto-start hooks. |
| Reviewed global Pi/Agent skills needed by the task | **Read-only mount** or **copy** | Skills are instructions/code and must be reviewed; project skills load only after trust. [Pi skills](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/skills.md) |
| Workspace | **Copy into guest by default**; RW mount only for an explicitly disposable worktree | Copy-in/export-patch gives strongest host integrity. |
| `settings.json` | **Generate sanitized** | Use dedicated `PI_CODING_AGENT_DIR`, `defaultProjectTrust: "never"`, curated packages/tools; remove absolute host paths, shell prefix, local package paths, and auto-install behavior. [Pi settings](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/settings.md) |
| Project `.pi/settings.json`, `.pi/extensions`, `.agents/skills`, `AGENTS.md` | **Copy only by policy** | Start `--no-approve`; context files can still carry prompt injection, so allow/disable deliberately. [Pi security](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md) |
| `.gitconfig` | **Generate sanitized** | Safe identity, `gc.auto=0`, no credential helpers, signing keys, includes, aliases, or host paths. |
| Writable HOME/XDG dirs, temp, caches, session dir | **Generate** in ephemeral volume | Never reuse host HOME; retain only selected caches if poisoning risk is accepted. |
| Pi package code/extensions | **Bake pinned and reviewed** | Pi packages/extensions run arbitrary code with Pi's authority. [Pi packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md) |
| `~/.pi/agent/auth.json`, OAuth state, sessions, trust decisions, MCP OAuth/config/cache, telemetry DBs | **Never expose** | Credentials, private transcripts, trust state, and host integrations. Pi stores provider tokens in `auth.json`. [Pi providers](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md#auth-file) |
| Shell secrets/generated secret files, `.npmrc`, cloud configs, SSH/GPG keys and agents, 1Password socket/config, browser profiles/keychains | **Never expose** | Broad reusable credentials and identity material. Keep safe templates host-only too; templates reveal account/vault structure and are not runtime needs. |
| Theme/prompt UI assets | **Host-only** for host-Pi design | Guest tools do not need them. |

## 5. Threat model and default controls

Assume malicious repository text, dependency/build scripts, model output, and guest processes; also assume runtime escape vulnerabilities remain possible.

- **Filesystem:** no host HOME; copy-in workspace and export a reviewed patch/artifacts. If RW is requested, mount only a newly created disposable worktree—not repository root, sibling worktrees, sockets, or broad parent directories. Never mount shared `.git` common data by default.
- **Git:** no SSH agent/credential helper; no push remote credentials; disable gc/maintenance; prevent push in the guest; host reviews and applies patch/commit. A command guard supplements, never replaces, mount isolation.
- **Network:** default no external egress. Apple's `--internal` is insufficient for host isolation; run under a dedicated macOS account and ensure sensitive host services do not bind reachable interfaces. For online tasks, add one authenticated egress proxy/broker with DNS rebinding protection, RFC1918/link-local/metadata denial, exact host+port allowlists, audit logs, and fail-closed headless behavior. This mirrors mature agent guidance that filesystem and domain network permissions are separate controls. [OpenAI Codex permissions](https://developers.openai.com/codex/permissions)
- **Secrets:** host Pi makes model calls. Guest receives no provider auth. Prefer brokered, destination-bound, short-lived credentials; otherwise inject a narrowly scoped token only for one command and destroy the container afterward. Never forward environment wholesale.
- **Process:** non-root UID, read-only rootfs, tmpfs for writable temp/HOME, drop all capabilities then add only measured needs, CPU/RAM/PID/time limits, no virtualization or host sockets, pinned image digest.
- **Tool surface:** explicit Pi tool allowlist; disable unreviewed project resources and custom extensions. Log launches, mounts, network decisions, and exports without logging secrets.

## 6. Smallest useful recommendation for this PR

This research-only PR establishes `packages/pi-drydock` with its own identity, cited decision record, readable blog post, and interactive HTML brief—no runtime claims yet. Follow-up implementation belongs inside `packages/pi-drydock` and starts with `bash`, a prebuilt pinned image, copy-in workspace, internal network, zero secrets, and patch export. One integration check should prove: guest can edit copied source; cannot read host HOME; cannot reach internet; cannot mutate the original worktree; exported patch applies.

Only after that check passes: implement file-operation adapters, then optional reviewed skill projection, then brokered egress. Davit integration is optional last-mile UI work.

**Explicit non-goals:** running all of Pi inside the guest; mounting host `~/.pi/agent`; forwarding SSH/1Password/keychain; dynamic dotfile installation; shared `.git` mounting; push/deploy/browser/MCP support; Gondolin compatibility or shared abstractions; replacing Davit or Apple's runtime; production security claims before escape/network tests.
