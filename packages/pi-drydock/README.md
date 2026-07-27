# pi-drydock

An independent Apple [`container`](https://github.com/apple/container)-backed sandbox for [Pi](https://github.com/earendil-works/pi-mono) tool execution, with [Davit](https://github.com/wouterdebie/davit) as an optional native operator UI.

> **Status: experimental tool.** `drydock_bash` works, but it does not override Pi's built-ins; every other active tool still runs on the host.

## Identity

A dry dock is a controlled place where work enters, gets isolated and inspected, then leaves through a deliberate handoff. That is the model here:

- Pi and provider credentials stay on the host.
- Reviewed tool calls run in a per-container Linux VM.
- Source is copied in; a patch or selected artifacts come out.
- Host HOME, reusable credentials, and shared git metadata stay outside.
- Davit may show logs, files, stats, and stop controls; it never defines policy.

`pi-drydock` is not a `pi-gondolin` backend or compatibility layer. It has its own Apple-platform contract, threat model, package lifecycle, and tests. Existing sandbox work remains useful prior art, not a dependency.

## Research artifacts

- [Cited decision record](./docs/research.md)
- [Blog: “Davit is the window, not the wall”](./docs/blog.md)
- [Interactive HTML brief](./docs/brief.html)
- [Validated boundary spike](./docs/spike-2026-07-26.md)

## Run the boundary spike

Requires Apple silicon, macOS 26, and Apple [`container`](https://github.com/apple/container) 1.1.0 with its system service running.

```sh
container system start
./scripts/spike.sh
```

The script starts a pinned Alpine image with a read-only root filesystem, tmpfs workspace, 1 CPU, 512 MB RAM, and an internal no-DNS network. A bootstrap process records the host gateway, brings `eth0` down, then drops to UID/GID 65534; the task cannot restore networking. The check probes both the host gateway and an external IP, exports a patch, verifies the host original is unchanged, and removes its container and network. Result files remain in the printed `/tmp/pi-drydock-spike.*` directory.

## Try the Pi tool

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

## Next slice

Add sandboxed file-tool adapters, then replace Pi's built-ins as one atomic mode. Untracked-file opt-in, binary patch export, approved egress, reviewed skill projection, and Davit integration remain later work.
