# pi-drydock

An independent Apple [`container`](https://github.com/apple/container)-backed sandbox for [Pi](https://github.com/earendil-works/pi-mono) tool execution, with [Davit](https://github.com/wouterdebie/davit) as an optional native operator UI.

> **Status: research-stage.** This directory defines the project boundary and first executable spike. It is not installable yet.

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

## First executable slice

The first implementation should support `bash` only:

1. Start a pinned Apple container as non-root with hard resource limits.
2. Copy a workspace snapshot into the guest with no host HOME, secrets, sockets, or shared `.git` data.
3. Disable external egress.
4. Run one command.
5. Export a patch for host review.
6. Prove the guest can edit its copy, cannot read host HOME or reach the internet, cannot mutate the original worktree, and produces a patch that applies.

File-tool adapters, reviewed skill projection, brokered egress, and Davit integration come only after that boundary check passes.
