# pi-drydock

An independent Apple [`container`](https://github.com/apple/container)-backed sandbox for [Pi](https://github.com/earendil-works/pi-mono) tool execution, with [Davit](https://github.com/wouterdebie/davit) as an optional native operator UI.

> **Status: boundary spike passed.** The isolation experiment is runnable; the Pi extension is not implemented yet.

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

The script starts a pinned Alpine image as UID/GID 65534 with all capabilities dropped, a read-only root filesystem, tmpfs workspace, 1 CPU, 512 MB RAM, and an internal no-DNS network. It streams one source file into the guest, edits it, exports a patch, verifies the host original is unchanged, applies the patch to a host-side copy, and removes its container and network. Result files remain in the printed `/tmp/pi-drydock-spike.*` directory.

## Next slice

Route Pi's `bash` tool through the validated launch and exec-stream path. File-tool adapters, host-gateway testing, reviewed skill projection, brokered egress, and Davit integration come later.
