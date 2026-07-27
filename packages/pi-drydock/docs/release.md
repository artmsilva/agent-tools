# pi-drydock release policy

## Channel

`0.2.x` is a private, source-installed release line. Install from the `agent-tools` repository with `npm run install:local` from `packages/pi-drydock`. `private: true` intentionally prevents accidental npm publication while ownership, package licensing, and npm trusted-publisher configuration remain undecided.

A public npm release is a separate explicit decision, not an automatic consequence of a GitHub release. Before removing `private`, the maintainer must choose a license, confirm the `pi-drydock` package name, configure npm provenance/trusted publishing, and add a package-specific publish workflow.

## Versioning

Use Semantic Versioning:

- `0.x` minor: interface changes may be breaking and require migration notes.
- `0.x` patch: backward-compatible fixes only.
- `1.0.0`: stable CLI and control-plane compatibility commitment.

Git tags use `pi-drydock-v<version>` so package releases cannot collide with other packages in this repository.

## 0.2 migration

`drydock setup` combines first-time Apple service and image setup. `drydock use <name>` selects a workspace-bound environment in host-local Git configuration, allowing normal lifecycle commands to omit the name.

When `enter` runs inside Herdr, Guest Pi lifecycle state is relayed through a bounded `/run` state file and reported by the trusted host only to the current pane. No Herdr capability enters the Guest.

`drydock enter` now owns one direct foreground Guest shell. The user starts and exits `pi` inside it; exiting Pi does not leave the Drydock. The former `run`, `sessions`, `attach`, `capture`, `resize`, and `stop` commands and the `pi-drydock/sessions` export were removed before public release. Use `pi --continue` inside a later Guest shell to resume a durable conversation record. Live processes do not detach or survive the owner Terminal.

## Supported first-release environment

- Apple silicon
- macOS 26
- Node.js 24 or newer
- Apple `container` CLI 1.1.0 (the tested version)
- `@earendil-works/pi-coding-agent` 0.81 or newer
- `@earendil-works/pi-ai` 0.82.1 or newer
- Anthropic host credentials readable by Pi

Other Apple-container versions are unsupported until their real smoke passes. Linux can run deterministic tests but cannot provide the production runtime.

## Release gate

1. `pi-drydock` GitHub workflow is green on the release commit.
2. `npm test`, `npm run check`, `npm run build`, `npm audit --omit=dev`, `npm run pack:check`, ShellCheck, and Fallow pass.
3. On a compatible Apple host, build the image and run persistence, Connector, handoff, and real-provider smokes.
4. Confirm every smoke emits final `PASS:` lines and no Drydock container or network remains.
5. Confirm Guest `auth.json` is empty, `eth0` remains down, host source is unchanged, and the exported patch still passes `git apply --check`.
6. Update migration notes for any changed CLI command, control-plane interface, metadata schema, or persistence format.
7. Tag `pi-drydock-v<package.json version>` and create the GitHub release.

A failed required gate blocks release. Apple/runtime failures are never classified as flakes without a confirmed green rerun.

## Compatibility contract

The supported caller-facing interfaces are:

- the `drydock` CLI documented in `README.md`;
- `DrydockControlPlane` and exported types from `pi-drydock`;
- versioned on-disk metadata read by the control plane.

Apple-container command lines, direct TTY execution, Guest bootstrap scripts, Connector framing, and archive implementation are internal. Historical proof scripts carry no compatibility guarantee.
