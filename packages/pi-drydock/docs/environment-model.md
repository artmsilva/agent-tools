# Drydock environment model

Sprites is useful here less as a feature checklist than as a product model: give agent work a durable computer-like identity, keep policy outside it, let compute disappear when idle, and make recovery routine.

Drydock applies that model locally. It does not attempt to reproduce Fly.io infrastructure or promise memory snapshots Apple `container` cannot provide.

## Mental model

A Drydock is not a command and not a container. It is a named environment.

- **Identity persists.** A user returns to the same Drydock across Pi sessions.
- **Files persist.** Workspace, isolated Git metadata, Pi session records, and installed project dependencies survive hibernation.
- **Compute is disposable.** Processes, memory, sockets, and `/tmp` may disappear whenever a Drydock hibernates.
- **Authority stays outside.** The host control plane owns policy, durable provider credentials, lifecycle, and handoff.
- **Work stays inside.** Pi and every shell/file operation execute in the Guest.

## States

```text
           activity
hibernated ────────> active
    ^                  |
    |                  | no foreground runs, commands,
    |                  | broker requests, or leases
    └──── idle grace ──┘

active|hibernated ── failure ──> faulted
any state ── explicit removal ──> destroyed
```

**Active** has running compute. **Hibernated** retains durable identity and files only. **Faulted** retains the last known-good durable state but cannot currently wake. **Destroyed** has no recoverable state unless an exported checkpoint exists.

There is no promise that a process survives hibernation. Every `drydock enter` starts a new Guest shell. The user starts Pi inside it; `pi --continue` resumes a durable conversation record, not the old process.

## Durable and ephemeral state

| Durable | Ephemeral |
| --- | --- |
| Workspace files | Running processes |
| Isolated guest `.git` | Memory |
| Pi conversation records and settings | Open TCP connections |
| Installed project dependencies | `/tmp` |
| Checkpoints and environment metadata | Connector session capability |
| Effective policy record | Provider credentials |

Persistence excludes host HOME, host `.git`, reusable provider credentials, and writable host workspace mounts.

## Control plane

The host control plane is the deep module. Callers should not need to know container names, networks, tar streams, capability bootstrap, snapshot layout, or wake sequencing.

Its target interface is deliberately small:

```text
drydock use <name>                  select a workspace-bound environment
drydock enter [name]                wake and enter a foreground Guest shell
drydock exec [name] <command>       wake, run one command, then hibernate
drydock checkpoint [name] ...       create, list, or restore a save point
drydock hibernate [name]            remove compute, retain durable state
drydock export [name]               produce a reviewed handoff
drydock destroy [name]              remove durable state explicitly
```

Status, logs, and effective policy are inspection views over the same module, not separate lifecycle authorities.

Apple `container` remains internal implementation. Do not introduce a runtime interface until a second runtime exists.

## Guest contract

The Guest receives:

- a private workspace and isolated Git metadata;
- Pi and approved development tools;
- a read-only description of effective policy;
- narrowly scoped Connector endpoints;
- checkpoint operations limited to its own Drydock.

The Guest does not receive:

- host HOME or shared Git metadata;
- provider credentials;
- the ability to widen policy;
- direct control of the host container runtime;
- automatic write access to the host checkout.

## Connectors and policy

Sprites separates egress policy from credential-bearing Connectors. Drydock should do the same.

A Connector exposes one external capability. The host holds the durable credential, validates method and destination, applies limits, and streams the result. The Guest receives only a short-lived capability scoped to one Drydock and Connector. Hibernation invalidates it; the control plane issues a replacement during wake without requiring Guest-visible provider authentication. If issuance, broker, or policy checks fail, access fails closed.

Connected mode replaces the link-down network with a host-owned allow rule for the Connector only. Every other host port, private address, DNS destination, metadata endpoint, and external route remains denied. Policy is inspectable but read-only in the Guest.

## Foreground work, activity, and hibernation

`drydock enter` runs one terminal-owned Guest shell through direct Apple-container TTY execution. It is not detachable. The user may start and exit Pi repeatedly without leaving the Guest. Exiting the shell closes the host Connector, persists the Guest filesystem, and removes compute. Pi conversation records live under Guest home rather than `/workspace`, so a later `pi --continue` can resume them without exporting private conversation data in the project patch.

The control plane considers a Drydock active while any of these exist:

- a foreground run or command;
- an in-flight Connector request;
- an explicit task lease.

When activity reaches zero, an idle grace period begins. New activity cancels it. Expiry triggers an atomic persistence boundary, then removes compute. Wake restores durable files before accepting foreground work or Connector traffic.

## Checkpoints

Automatic persistence protects continuity; checkpoints protect intent. Create one before unattended dependency changes, migrations, or destructive refactors.

A checkpoint captures durable Guest state, not process memory. Restore is atomic: either the selected checkpoint becomes current or the prior known-good state remains. The current state and at least one known-good checkpoint cannot both be pruned by one operation.

## Handoff

The host checkout remains unchanged until explicit export. `importWorkspace()` first binds an active, lease-free Drydock to one canonical Git root and transfers only stage-0 tracked regular files. It records the exact imported worktree digest in host-only metadata and turns the Guest baseline read-only. Symlinks, gitlinks, ignored/untracked host files, Git metadata, xattrs, ACLs, and flags are rejected or excluded.

`exportWorkspace()` creates an immutable, size-bounded, binary-capable Git patch under host Drydock state. It verifies the bound source before and after generation and requires `git apply --check` against that destination. Export never applies the patch or writes into the checkout. Persistence is not synchronization; explicit review remains the authority boundary.

## Roadmap

### Evidence and proofs — complete or in review

- PR #2: foundational threat model and Apple-container boundary evidence.
- PR #3: transitional `drydock_bash` compatibility bridge and patch-export proof.
- PR #4: directional Pi-inside TTY and isolated-Git proof; `inside.sh` is transitional.

PR #4's guest stays running until explicitly stopped. That demonstrates session continuity only; it does not satisfy durable persistence, automatic hibernation, crash recovery, or disposable-compute guarantees. The environment control plane replaces that lifecycle rather than layering on it.

### Environment control plane

- Named Drydock identity and metadata.
- Durable, atomic filesystem store.
- `open`, `hibernate`, `status`, and `destroy` lifecycle.
- Crash recovery and last-known-good state.

### Real agent work

- Credentialless model Connector.
- Host-owned, Guest-readable network policy.
- One real Pi prompt with every tool executing inside.

### Conversation continuity

- Direct foreground Guest shell with user-started Pi, durable conversation records, and no process-continuity promise.
- Activity tracking, idle grace period, and task leases.
- Automatic hibernation and cold wake.

### Recovery and operations

- [x] Explicit checkpoints and restore.
- [x] Reviewed, destination-bound patch export.
- [x] Stale-state pruning and resource limits.
- [x] Automated CI and stable foreground CLI.
- [x] Versioning, compatibility, and release criteria.

## Explicit non-goals

- Copying Sprites' cloud billing, public URLs, or multi-tenant control plane.
- Claiming process or memory preservation across cold wake.
- Supporting multiple runtimes before a real second adapter exists.
- Selecting or building a companion app before CLI use proves one is needed.
- Making Pi, Guest code, or a future app a source of security policy.

## Inspiration

- [Sprites overview](https://docs.sprites.dev/index.md) — persistent computer-like identity for agent work.
- [Lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle.md) — durable disk with disposable compute and connections.
- [Exec sessions](https://docs.sprites.dev/api/v001-rc46/exec.md) — attachable TTY sessions with resize and reconnect.
- [Checkpoints](https://docs.sprites.dev/concepts/checkpoints.md) — deliberate recovery points alongside automatic persistence.
- [Networking](https://docs.sprites.dev/concepts/networking.md) and [Connectors](https://docs.sprites.dev/concepts/connectors) — externally owned policy and credential brokering.
