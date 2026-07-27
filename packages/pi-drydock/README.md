# pi-drydock

A named, durable local environment where Pi can work without receiving authority over the host computer. Apple [`container`](https://github.com/apple/container) supplies disposable compute; the trusted `drydock` CLI owns lifecycle, credentials, persistence, checkpoints, sessions, and reviewed handoff.

> **Status: private 0.1 release candidate.** The package is not published yet. See [release policy](./docs/release.md).

**New to Drydock?** Follow the plain-language [Getting started guide](./docs/getting-started.md).

## Requirements

- Apple silicon and macOS 26
- Apple `container` (tested with CLI 1.1.0)
- Node.js 24+
- Pi with a host Anthropic credential

From this repository:

```sh
cd packages/pi-drydock
npm install
npm link
drydock system start
drydock image
```

`drydock image` builds the pinned Debian/Node/Pi Guest image. Apple `container` remains an implementation detail; normal lifecycle work uses only the `drydock` interface.

## Normal workflow

```sh
# Import only stage-0 tracked regular files, then leave a cold environment.
drydock create project-alpha /path/to/git/worktree

# Start a fixed-policy, credentialless Connector and run Pi inside the Guest.
drydock run project-alpha

# One-shot Guest work: cold wake -> command -> hibernate.
drydock exec project-alpha 'npm test'

# Create rollback state and an explicit reviewed patch handoff.
drydock checkpoint project-alpha
drydock checkpoints project-alpha
drydock export project-alpha

# Remove the named environment when finished.
drydock destroy project-alpha
```

`run` is the foreground owner. It keeps Connector credentials in host memory while Pi runs inside the Guest. Press **Ctrl+]** to detach without stopping Pi; while the owner remains running, another terminal can use:

```sh
drydock sessions project-alpha
drydock attach project-alpha <session-id>
drydock capture project-alpha <session-id> 500
drydock resize project-alpha <session-id> 120 40
drydock stop project-alpha <session-id>
```

If the foreground owner is killed, Guest processes and Connector capability are disposable. Recover files and remove orphan compute with `drydock reconcile`, then run the environment again.

## Lifecycle commands

```text
drydock system start
drydock image [tag]
drydock create <name> [source]
drydock list
drydock run <name> [pi args...]
drydock exec <name> <shell command>
drydock sessions <name>
drydock attach <name> <session-id>
drydock capture <name> <session-id> [lines]
drydock resize <name> <session-id> <columns> <rows>
drydock stop <name> <session-id>
drydock checkpoint <name>
drydock checkpoints <name>
drydock restore <name> <checkpoint-id>
drydock export <name>
drydock hibernate <name>
drydock reconcile
drydock destroy <name>
```

The first release fixes `run` to Anthropic `claude-haiku-4-5`, a 12-hour maximum Connector capability, and host-owned request limits. The Guest receives only a loopback provider and non-secret sentinel; real auth is injected upstream by the host broker.

## Reviewed handoff

`create` binds one canonical Git root and imports only `git ls-files --cached` stage-0 regular files. Symlinks, gitlinks, ignored/untracked files, Git metadata, xattrs, ACLs, and macOS flags do not cross into the Guest.

`export` compares `/workspace` with the root-owned immutable `/baseline`, creates a bounded binary-capable Git patch, verifies the bound host source digest and `git apply --check`, and writes owner-only patch metadata under the Drydock state directory. It never changes the host checkout. Applicability is point-in-time; recheck the recorded source digest immediately before applying.

## Persistence model

- Identity and Guest files survive hibernation and host-process restarts.
- Processes, memory, sockets, `/tmp`, `/run`, sessions, and Connector capabilities do not survive hibernation.
- Automatic persistence streams a validated full-root archive to an exclusive `0600` temporary file, fsyncs, atomically renames, then deletes compute.
- Immutable UUID checkpoints provide rollback; they are not synchronization.
- Restart reconciliation hibernates orphan compute before making it available again.

State defaults to `~/Library/Application Support/pi-drydock`. Override it with `DRYDOCK_STATE_ROOT`; override the management executable with `DRYDOCK_CONTAINER`.

## Security boundary

- No writable host workspace, host HOME, shared `.git`, published port, SSH daemon, or reusable Guest credential.
- Guest `eth0` is down after bootstrap and cannot be restored by UID 1000.
- Model traffic uses a Guest-loopback shim over `container exec --interactive` stdio.
- Connector provider, model, origin, path, headers, limits, rate, concurrency, timeout, and expiry are host-owned.
- Lifecycle transitions and sessions use exact-once activity leases.
- The host `container` CLI is privileged; unrestricted root exec outside the control plane voids Guest policy.

## Library interface

```ts
import { DrydockControlPlane } from "pi-drydock";

const drydocks = new DrydockControlPlane();
await drydocks.create("project-alpha");
await drydocks.open("project-alpha");
await drydocks.importWorkspace("project-alpha", process.cwd());
const result = await drydocks.exec("project-alpha", "npm test");
await drydocks.hibernate("project-alpha");
```

The control plane is the stable module seam. Apple-container commands, atomic archives, credential transport, tmux control mode, and policy enforcement stay behind it.

## Validation

Relevant pull requests and `main` run tests, TypeScript, ShellCheck, production dependency audit, package dry-run, and Fallow on Ubuntu. Before release, an Apple-silicon maintainer also runs:

```sh
./scripts/persistence-smoke.sh
./scripts/connector-smoke.sh
./scripts/handoff-smoke.sh
./scripts/real-provider-smoke.sh # uses host Anthropic auth and spends tokens
```

Every script must emit final `PASS:` lines. `container list --all` and `container network list` must show no Drydock resources afterward.

## Architecture records

- [Domain language](./CONTEXT.md)
- [Environment model](./docs/environment-model.md)
- [ADR: durable environment as the core model](./docs/adr/0001-durable-environment-model.md)
- [Research and proof history](./docs/research.md)
