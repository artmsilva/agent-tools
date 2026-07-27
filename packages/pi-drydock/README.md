# pi-drydock

A persistent local environment where [Pi](https://github.com/earendil-works/pi-mono) can work without receiving authority over the host computer. Apple [`container`](https://github.com/apple/container) supplies the current isolated compute; [Davit](https://github.com/wouterdebie/davit) may become an optional operator UI.

> **Status: experimental architecture.** The boundary, named identity, Pi-inside TTY, and one manual cold-persistence cycle are proven. Automatic hibernation, checkpoints, and credentialless model access remain roadmap work.

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

Metadata is versioned, atomically written with owner-only permissions, and stored outside the workspace under `~/Library/Application Support/pi-drydock/environments`. Corrupt or newer metadata fails closed. This slice establishes identity only; it does not yet claim guest persistence, wake, hibernation, or container provisioning.

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

There is no idle timer, automatic checkpointing, or service restart in this slice—every `open`/`exec`/`hibernate` call is deliberate and synchronous.

Run the real-hardware cycle once with `./scripts/persistence-smoke.sh` (opt-in; requires Apple silicon, macOS 26, `container system start`, and the `pi-drydock-pi:latest` image from `scripts/build-inside-image.sh`). `src/control-plane-persistence.test.ts` covers the same logic in `npm test` against a fake `container` CLI backed by real directories, so CI does not need Apple `container`.

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

The proof is intentionally offline: it does not mount or copy host `auth.json`, and Pi cannot reach a model provider while `eth0` is down. The host `container` CLI remains a privileged management boundary; bypassing `inside.sh` with an unrestricted root exec voids the guest policy. Useful agent work therefore requires a narrowly exposed host model broker; forwarding durable credentials or restoring general guest networking is not an acceptable shortcut.

## Roadmap

The target is a named, durable environment—not a growing collection of sandboxed tool adapters. See the [environment model](./docs/environment-model.md) for lifecycle, persistence, sessions, Connectors, checkpoints, handoff, and delivery phases.

The next implementation slices add activity leases and automatic hibernation around the proven cold boundary, then a credentialless model Connector so one real Pi prompt can execute every tool inside the Guest.
