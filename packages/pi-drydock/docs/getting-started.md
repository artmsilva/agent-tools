# Getting started with pi-drydock

This guide assumes you are comfortable copying commands into Terminal, but you do not need to understand containers, virtual machines, or the pi-drydock architecture.

## What pi-drydock does

Think of a Drydock as a locked workshop for an AI coding agent:

1. You choose a Git project on your Mac.
2. Drydock copies the project's **tracked files** into an isolated Linux Guest.
3. Pi works on the copy, not your original project.
4. Drydock saves the Guest files when Pi stops.
5. When you want the work back, Drydock produces a patch for you to inspect and apply.

Your original project is not changed automatically. Provider credentials stay on your Mac. The Guest has no normal internet connection; model requests travel through a narrow host-managed Connector.

## Before you start

pi-drydock currently requires:

- an Apple-silicon Mac;
- macOS 26;
- Apple's `container` tool;
- Node.js 24 or newer;
- Pi;
- at least one model provider configured in host Pi;
- a project stored in Git.

Check what is already installed:

```sh
container --version
node --version
pi --version
git --version
```

If `container` is missing, install it using the [official Apple container instructions](https://github.com/apple/container), then run the check again.

If Pi is missing:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### Configure models through host Pi

Drydock uses the providers and models available to Pi on your Mac. Credentials and provider requests remain host-side.

Start Pi on your Mac and use `/login` for any provider you want available:

```sh
pi
```

```text
/login
```

Custom providers from `~/.pi/agent/models.json` are supported too. If a key or header uses a command such as `!op read 'op://Private/AI/key'`, that command runs on the host. Unlock 1Password before entering the Drydock. The Guest never receives `op`, its session, or the resolved secret.

## Install pi-drydock

The package is currently installed from source rather than npm.

```sh
git clone https://github.com/artmsilva/agent-tools.git
cd agent-tools/packages/pi-drydock
npm run install:local
```

Confirm the command is available:

```sh
drydock --help
```

If your shell says `drydock: command not found`, close and reopen Terminal after installation, then try again.

`npm install` may report a vulnerability in development tooling. Check the shipped runtime separately:

```sh
npm audit --omit=dev
```

The release gate requires this production audit to report zero vulnerabilities. Do not run an automatic audit fix unless you intend to change the repository lockfile.

## One-time setup

Start Apple's container services and build the Drydock Guest image:

```sh
drydock setup
```

The image build can take several minutes the first time. You normally rebuild it only after updating pi-drydock.

## Your first Drydock

### 1. Prepare a Git project

Move into the project you want Pi to work on:

```sh
cd /path/to/your/project
git status
```

Drydock imports files already known to Git. Untracked and ignored files are deliberately left on the host.

To see which files are untracked:

```sh
git status --short
```

If an important file starts with `??`, add it to Git before creating the Drydock, or accept that it will not be copied.

### 2. Choose a Drydock name

Names use lowercase letters, numbers, and hyphens. Examples:

- `website`
- `invoice-fix`
- `project-alpha`

Create an isolated environment from the current project, then select it for this Git repository:

```sh
drydock create project-alpha
drydock use project-alpha
```

Optional: configure a separate, secret-free dotfiles Git checkout before `create`:

```sh
export DRYDOCK_DOTFILES_ROOT="$HOME/path/to/drydock-dotfiles"
export DRYDOCK_DOTFILES_INSTALL="./install.sh" # optional
drydock create project-alpha
```

Use a dedicated Guest-only repository, not your normal personal dotfiles checkout: Drydock cannot prove that shell profiles contain no literal secrets. Only tracked regular files are copied into `/home/node`. Credential directories/files and secret-like filenames are rejected. The optional installer runs inside the offline Guest as its unprivileged user.

The selection is stored in local Git configuration. It does not create or change a tracked project file. You can now omit `project-alpha` from normal commands.

`drydock create`:

- creates the named environment;
- copies the tracked project files;
- records an immutable starting point;
- saves the environment in a cold state with no Guest processes running.

The JSON printed by `create` is a receipt containing the environment ID and source details. You do not need to edit it.

### 3. Enter the Guest and start Pi

```sh
drydock enter
```

This opens a normal shell inside the isolated Guest. Start Pi when you want it:

```sh
pi
```

Ask Pi to inspect the project, make changes, and run tests as usual. `/model` shows the host-available model snapshot captured when `drydock enter` started. Switching models does not expose provider credentials to the Guest. Provider usage may incur charges.

### 4. Finish and resume later

The Terminal running `drydock enter` is the **owner**. Live processes are not detachable.

Exit Pi normally when finished. You remain inside the Guest shell and may run tests, inspect files, or start Pi again. Exit the Guest shell when finished:

```sh
exit
```

Drydock then closes the Connector, saves the Guest filesystem, removes active compute, and returns to your Mac shell.

Pi conversation history is saved inside the Drydock, outside `/workspace`. After entering the Drydock again, continue the most recent conversation with:

```sh
pi --continue
```

The conversation and files survive. The old Pi and shell processes do not.

## Run a single command without opening Pi

Use `exec` for a one-off command:

```sh
drydock exec 'npm test'
```

The shell command must be one quoted argument. Drydock wakes the environment, runs the command inside it, prints the output, and returns it to cold storage.

Other examples:

```sh
drydock exec 'git diff --stat'
drydock exec 'npm run check'
drydock exec 'ls -la'
```

These commands operate on the Guest copy, not the host checkout.

## Save a checkpoint before risky work

A checkpoint is a rollback point for Guest files. Run checkpoint and restore commands from your Mac shell after exiting the Guest:

```sh
drydock checkpoint
drydock checkpoints
```

Copy the checkpoint ID from the output. To roll the Guest back later:

```sh
drydock restore CHECKPOINT_ID
```

Restoring a checkpoint does not change your host project.

## Bring reviewed work back to your Mac

Drydock never silently synchronizes Guest changes into the host project.

Create a handoff patch:

```sh
drydock export
```

The output includes a `patchPath`, for example:

```json
{
  "patchPath": "/Users/you/Library/Application Support/pi-drydock/project-alpha/handoffs/EXAMPLE.patch"
}
```

Copy that path and assign it to a shell variable:

```sh
PATCH='/the/path/from/patchPath'
```

Review what would change:

```sh
git apply --stat "$PATCH"
git apply --check "$PATCH"
less "$PATCH"
```

- `--stat` summarizes affected files.
- `--check` verifies that the patch still applies.
- `less` lets you inspect the actual patch; press `q` to leave.

Only when you are satisfied should you apply it:

```sh
git apply "$PATCH"
git status
git diff
```

`git apply` is the step that changes your host project. Drydock does not run it for you.

If `drydock export` says the source changed since import, stop. Drydock is protecting you from applying work to a different host state. Do not destroy the Drydock until you have decided how to preserve both sets of work.

## Everyday commands

List your environments:

```sh
drydock list
```

Enter the Guest and run Pi again:

```sh
drydock enter
pi
```

Save active compute manually:

```sh
drydock hibernate
```

Destroy an environment after its work is safely exported:

```sh
drydock destroy
```

`destroy` permanently removes that Drydock's Guest files, checkpoints, and handoffs. It does not delete the original Git project.

## Recover after a crash or closed Terminal

If the owner Terminal was killed, the Mac restarted, or a command reports leftover active resources, first make sure no `drydock enter` command for that environment is still legitimately running. Then run:

```sh
drydock reconcile
```

Reconciliation saves orphaned Guest files when possible, removes stale compute/network resources, and returns environments to a safe cold state.

Then continue normally:

```sh
drydock enter
```

## Troubleshooting

### `drydock: command not found`

From `agent-tools/packages/pi-drydock`:

```sh
npm run install:local
```

Open a new Terminal and run `drydock --help`.

### `Host Pi has no configured model connections`

Run host Pi and use `/login`, or configure `~/.pi/agent/models.json`. If the provider uses `!op read`, unlock 1Password on the host and retry.

### Guest image not found

```sh
drydock setup
```

### Workspace root cannot contain symlinks

Use the physical project path:

```sh
cd /path/to/project
pwd -P
drydock create project-alpha "$(pwd -P)"
```

Drydock also rejects tracked symbolic links and Git submodules in this release.

### Drydock already exists

List existing names:

```sh
drydock list
```

Use the existing name, choose a new name, or destroy the old environment after confirming its work is no longer needed.

### Drydock is already active

Another owner may still be running. Check your Terminals before doing anything. If the owner is gone unexpectedly, run `drydock reconcile`.

### A command failed

The error does not automatically mean Guest files were lost. Run:

```sh
drydock list
drydock reconcile
```

Then retry. Do not use raw `container` commands to repair a Drydock; that bypasses its safety rules.

## Common questions

### Does Pi edit my original files?

No. Pi edits `/workspace` inside the Guest. Your host project changes only when you deliberately apply an exported patch.

### What survives after Pi stops?

The named identity, Guest files, and Pi conversation history survive. Processes, terminals, memory, network connections, `/tmp`, and Connector capability do not.

### Where is Drydock state stored?

By default:

```text
~/Library/Application Support/pi-drydock
```

Do not edit those files by hand.

### Can the Guest access the internet?

Not normally. Its network interface is down. The host Connector permits only Pi model-stream requests for models available through the host runtime.

### Are my provider or 1Password credentials copied into the Guest?

No. Credentials, OAuth refresh, ambient cloud configuration, `op`, and 1Password sessions remain host-side. The Guest receives model events through a temporary loopback connection, not reusable credentials.

### Can I use a different model?

Yes. Use `/model` inside Guest Pi. The list is the host-available model snapshot captured by `drydock enter`; exit and re-enter after changing host model configuration.

### Does Herdr show Pi running inside a Drydock?

Yes. When you enter from a Herdr pane, starting Pi marks that pane as a Pi agent and reports `idle` or `working`. Exiting Pi clears the indicator but leaves you in the Guest shell. The Guest never receives access to Herdr's host socket.

### Can I close the owner Terminal while Pi is running?

No. Exit Pi, then exit the Guest shell so Drydock can persist cleanly. If the Terminal closes unexpectedly, run `drydock reconcile`, enter again, and use `pi --continue` to resume the saved conversation.

### Do I need a desktop app?

No. The CLI supports the complete current lifecycle. A separate app should be considered only if real use shows repeated difficulty managing multiple environments, background owners, notifications, or visual patch review.

## Short version

For later reference, the normal loop is:

```sh
cd /path/to/project
drydock create project-alpha     # once
drydock use project-alpha        # select for this Git project
drydock enter                    # enter Guest; run pi inside
drydock checkpoint               # optional rollback point
drydock export                   # produce reviewable patch
drydock destroy                  # only after work is safe
```
