# pi-drydock

A persistent local environment where [Pi](https://github.com/earendil-works/pi-mono) can work without receiving authority over the host computer. Apple [`container`](https://github.com/apple/container) supplies the current isolated compute; [Davit](https://github.com/wouterdebie/davit) may become an optional operator UI.

> **Status: experimental architecture.** The boundary, named lifecycle, automatic hibernation, restart reconciliation, checkpoints, Pi-inside TTY, credentialless Connector transport, and one real Pi/provider prompt are proven.

## Identity

A dry dock is a controlled place where work enters, gains continuity, stays isolated, and leaves through deliberate handoff. That is the model here:

- A named Drydock keeps its identity and guest filesystem across conversations and hibernation.
- Pi, shell commands, and file operations run inside the Guest.
- The host control plane owns lifecycle, policy, checkpoints, Connectors, and handoff.
- Provider credentials remain in host-managed Connectors; the Guest receives scoped capability, not durable secrets.
- Files survive cold wake; processes, memory, sockets, and `/tmp` do not.
- Host HOME, writable workspace mounts, and shared Git metadata stay outside.
- Davit may show logs, files, stats, and controls; it never defines policy.

`pi-drydock` is not a `pi-gondolin` backend, compatibility layer, or thin wrapper around Apple containers. It owns a persistent-environment model, threat model, lifecycle, and tests. Apple `container` is its first implementation rather than its caller-facing identity.

## Model and research

- [Domain language](./CONTEXT.md)
- [Environment model and roadmap](./docs/environment-model.md)
- [ADR: durable environment as the core model](./docs/adr/0001-durable-environment-model.md)
- [Original cited decision record](./docs/research.md)
- [Blog: “Davit is the window, not the wall”](./docs/blog.md)
- [Interactive HTML brief](./docs/brief.html)
- [Validated boundary spike](./docs/spike-2026-07-26.md)
- [Pi-inside-container research](./docs/pi-inside-research.md)
- [Pi-inside-container spike](./docs/pi-inside-spike-2026-07-26.md)

## Control plane tracer bullet

The first host control-plane slice reserves stable named Drydock identities behind one module:

```ts
import { DrydockControlPlane } from "pi-drydock/control-plane";

const drydocks = new DrydockControlPlane();
await drydocks.create("project-alpha");
await drydocks.get("project-alpha");
await drydocks.list();
await drydocks.destroy("project-alpha");
```

Metadata is versioned, atomically written with owner-only permissions, and stored outside the workspace under `~/Library/Application Support/pi-drydock/environments`. Corrupt or newer metadata fails closed. The later lifecycle slices build on this stable identity.

### One manual cold cycle

The same control plane also drives one full cold cycle against the real Apple `container` CLI:

```ts
await drydocks.open("project-alpha"); // creates network/container, restores rootfs.tar if present
await drydocks.exec("project-alpha", "echo hi"); // uid/gid 1000, /workspace, setpriv NNP + no caps
await drydocks.hibernate("project-alpha"); // streams and validates a root tar, then deletes compute
```

`open` provisions a writable-root container (only `/tmp` is tmpfs) with `eth0` down. Host-controlled snapshot export/restore receives the temporary filesystem capabilities it needs; Pi/user commands still run as UID/GID 1000 with `NoNewPrivs` and zero effective, inheritable, and ambient capabilities. Resource names derive from the Drydock UUID.

`hibernate` streams the root filesystem to an exclusive `0600` same-directory temp file, excluding `/proc`, `/sys`, `/dev`, `/run`, `/tmp`, sockets/devices, and Pi `auth.json`. It fsyncs and validates archive paths/types before atomic rename, then deletes container before network. Export or validation failure leaves running compute and any prior snapshot untouched; corrupt restore cleans only partial compute and retains the snapshot. All operations have bounded timeouts, and genuine cleanup failures retain identity for retry.

Full-root persistence intentionally retains files and secrets created inside the Guest. It is not a general credential scrubber. The enforceable boundary is that the control plane never introduces provider credentials and Pi `auth.json` is explicitly excluded.

`open` arms a five-minute idle timer by default. `exec` and explicit `acquireLease()` task leases cancel that timer; the final release rearms it. Idle expiry calls the same atomic `hibernate` path, while failures reach the host through `onBackgroundError` and retain recoverable state. Set `idleTimeoutMs: 0` to disable the timer.

The timer belongs to the current host control-plane process. A new single-owner control-plane process must call `reconcile()` before accepting work: live orphan compute is snapshotted and hibernated, network-only debris is removed, and stale snapshot temps are deleted only after the environment reaches known inactive state. Uncertain inspect/export/delete failures are aggregated and retain identity/resources for retry.

`checkpoint()` creates an immutable UUID-addressed full-root rollback point without hibernating active compute; `listCheckpoints()` survives host restart. `restoreCheckpoint()` validates and stages the archive before discarding active compute, then atomically replaces the inactive root snapshot. Task leases and lifecycle transitions block checkpoint races. Checkpoint deletion and retention policy are intentionally deferred until storage pressure makes them necessary.

Run the real-hardware cycle once with `./scripts/persistence-smoke.sh` (opt-in; requires Apple silicon, macOS 26, `container system start`, and the `pi-drydock-pi:latest` image from `scripts/build-inside-image.sh`). `src/control-plane-persistence.test.ts` covers the same logic in `npm test` against a fake `container` CLI backed by real directories, so CI does not need Apple `container`.

## Connector transport tracer bullet

`attachConnectorBroker()` connects a guest-loopback HTTP shim to a host broker over one trusted `container exec --interactive` stdio channel. There is no host listener, published port, SSH daemon, bearer token, or reopened guest interface: `eth0` remains down. The ephemeral exec channel itself is the Drydock-scoped capability; closing either side expires it.

The host fixes provider, model, HTTPS origin, method, path, request/response size, concurrency, rate, and timeout. It ignores every guest header, injects credentials from an in-memory resolver, disables redirects, allowlists response headers, bounds protocol frames, and streams response chunks. Effective non-secret policy is readable at `/.well-known/pi-drydock-connector`. Credentials are rejected from public fixed policy and host failures are redacted before crossing the channel.

The guest shim is injected read-only under excluded `/run`, binds only `127.0.0.1`, and disappears with compute. `./scripts/connector-smoke.sh` proves the real Apple transport against an in-process fake upstream without spending model tokens. Unit tests cover streaming, policy inspection, method/path/model denial, guest-header stripping, host credential injection/redaction, request/response/frame bounds, concurrency, rate, timeout, and broker-restart expiry.

`createAnthropicCredentialHeadersResolver()` reads the host's existing Pi Anthropic credential, refreshes expiring OAuth in host memory, and returns upstream-only headers. The Guest provider extension contains only a non-secret OAuth-format sentinel so Pi formats the request correctly; the broker discards that sentinel before injecting real host auth. `accept-encoding: identity` prevents compressed upstream bytes from crossing the framed stream without matching response metadata.

`DrydockControlPlane.openConnector()` installs the excluded read-only Guest resources, starts the exec channel, waits for policy readiness, and holds one activity lease. Its capability expires after 15 minutes by default, on explicit close, on channel/broker failure, or before managed hibernate/destroy/checkpoint restore. Release rearms the normal idle timer. Session closure is idempotent and bounded; forced channel death surfaces through `closed` and the background-error callback.

`./scripts/real-provider-smoke.sh` is opt-in and spends real model tokens. It proves a real Haiku prompt, a model-requested Guest `bash` tool call, empty Guest credential storage, down `eth0`, managed hibernation expiry, cold restore without `/run` capability files, unchanged host source, and complete resource cleanup.

## Managed Guest sessions

`startSession()` runs an argv-safe command under Guest UID/GID 1000 and `/workspace` in a UUID-named tmux session. `attachSession()` uses tmux control mode over ordinary exec pipes, so callers can send UTF-8 bytes and receive decoded live PTY output without SSH, a host TTY, or another port. `captureSession()` returns bounded history; `resizeSession()`, `listSessions()`, and `stopSession()` provide the remaining lifecycle controls.

Each managed session owns one Drydock activity lease. Detach leaves Guest work running; stop, command exit, or observed disappearance releases exactly once. A bounded background pane-state probe detects command exit while retaining tmux's final buffered output until idle hibernation. Explicit hibernate/destroy/checkpoint restore closes the Connector, stops live sessions, then proceeds. Hibernation deliberately discards tmux processes/sockets while Pi's ordinary on-disk session files and workspace survive in the root snapshot. The image adds tmux as the only new Guest runtime dependency.

The real-provider smoke proves start → attach → resize → detach → continued work → buffered capture → reattach/input → stop, then runs the real Pi/tool turn in a detached managed session and verifies exit-lease release, automatic hibernation, and no process session after cold wake.

## Reviewed workspace handoff

`importWorkspace()` binds one active, lease-free Drydock to one canonical Git repository root. It copies only stage-0 regular files reported by `git ls-files --stage`; ignored/untracked host files, symlinks, gitlinks, `.git`, xattrs, ACLs, and flags do not cross. The exact imported worktree bytes—not merely `HEAD`—are hashed into owner-only host metadata. `/baseline` becomes root-owned and read-only while `/workspace` remains Guest-writable.

`exportWorkspace()` verifies that the bound host source still matches that digest, creates a bounded binary-capable Git patch from the immutable baseline, checks it with host `git apply --check`, verifies source drift again, and publishes owner-read-only patch plus metadata under the Drydock state directory. It never applies or copies files into the host checkout. That check is point-in-time: any later apply flow must recheck the recorded source digest immediately before applying. Hibernation preserves baseline/workspace files but not export processes.

`./scripts/handoff-smoke.sh` proves tracked-only import, immutable baseline, text and binary edits, cold restore, destination drift checks, applicable patch export, unchanged host files, and resource cleanup against real Apple `container`.

## Run the boundary spike

Requires Apple silicon, macOS 26, and Apple [`container`](https://github.com/apple/container) 1.1.0 with its system service running.

```sh
container system start
./scripts/spike.sh
```

The script starts a pinned Alpine image with a read-only root filesystem, tmpfs workspace, 1 CPU, 512 MB RAM, and an internal no-DNS network. A bootstrap process records the host gateway, brings `eth0` down, then drops to UID/GID 65534; the task cannot restore networking. The check probes both the host gateway and an external IP, exports a patch, verifies the host original is unchanged, and removes its container and network. Result files remain in the printed `/tmp/pi-drydock-spike.*` directory.

## Try the compatibility tool

```sh
npm install
pi -e .
```

Ask Pi to call `drydock_bash` with a network-free shell command. Each call:

1. Creates a fresh pinned Apple container.
2. Uses `git ls-files --cached` to stream only tracked paths into `/baseline`; modified tracked content is included, while ignored and untracked files never cross the boundary.
3. Copies that snapshot to a writable tmpfs workspace.
4. Runs the command as UID/GID 65534 with `eth0` down and non-restorable.
5. Returns stdout, stderr, exit code, and a text-only patch without applying it.
6. Deletes the container and its temporary network.

Tracked files are treated as repository authority. Drydock excludes ignored and untracked files but cannot identify an intentionally committed secret; do not keep credentials in Git.

## Try the Pi-inside direction

This proof uses Apple `container exec --interactive --tty` as the management channel; it does not run an SSH daemon or open a port.

```sh
./scripts/build-inside-image.sh
./scripts/inside.sh start
./scripts/inside.sh enter
# Exit Pi with Ctrl-D, then:
./scripts/inside.sh patch
./scripts/inside.sh stop
```

`start` copies the Git-tracked snapshot once. Pi, its sessions, and every tool it launches then live in the persistent guest tmpfs. `patch` exports cumulative text changes; the host checkout remains unchanged. `smoke` verifies the image, TTY, input forwarding, UID 1000, `NoNewPrivs`, disabled networking, and absent host auth.

The original proof is intentionally offline: it does not mount or copy host `auth.json`. The Connector path above now provides real model access while `eth0` stays down and Guest `auth.json` remains empty. The host `container` CLI remains a privileged management boundary; bypassing the control plane with an unrestricted root exec voids guest policy.

## Validation

Pull requests that touch this package run unit tests, TypeScript, ShellCheck, the production dependency audit, and Fallow on GitHub's Ubuntu runner. Real Apple-container proofs remain local and opt-in because hosted runners lack Apple `container`; the provider proof also spends real model tokens.

Before a release on Apple silicon/macOS 26:

```sh
container system start
./scripts/build-inside-image.sh
./scripts/persistence-smoke.sh
./scripts/connector-smoke.sh
./scripts/real-provider-smoke.sh # requires host Anthropic auth; spends tokens
```

Each script must emit its final `PASS:` lines. Cleanup is complete when `container list --all` contains no Drydock container and `container network list` contains no Drydock network.

## Roadmap

The target is a named, durable environment—not a growing collection of sandboxed tool adapters. See the [environment model](./docs/environment-model.md) for lifecycle, persistence, sessions, Connectors, checkpoints, handoff, and delivery phases.

The durable environment core, Connector, sessions, and reviewed handoff are complete. Remaining productization: automated CI, Davit observation/controls, and the stable user/release surface tracked from epic #6.
