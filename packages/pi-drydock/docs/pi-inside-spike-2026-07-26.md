# Pi-inside-container spike — 2026-07-26

## Result

Pi 0.82.1 launches inside an Apple container and accepts host terminal input through `container exec --interactive --tty`. No SSH daemon, published port, host HOME mount, or host credential copy is required.

```text
PASS: pi=inside tty=yes input_forwarded=yes uid=1000 no_new_privs=yes network=down host_auth=absent
```

## Reproduce

```sh
./scripts/build-inside-image.sh
./scripts/inside.sh smoke

./scripts/inside.sh start
./scripts/inside.sh enter
# Ctrl-D exits Pi
./scripts/inside.sh patch
./scripts/inside.sh stop
```

## Verified boundary

- The image contains Node, Pi, Bash, Git, `fd`, and `rg` before runtime.
- The host sends a Git-tracked snapshot once; tar does not recurse into gitlink/submodule directories.
- The guest gets fresh isolated Git metadata, not the host repository's `.git` directory.
- Pi and its child tools run as UID/GID 1000 with `NoNewPrivs: 1` and no effective, inheritable, or ambient capabilities.
- Bootstrap brings `eth0` down; wrapped unprivileged exec processes cannot restore it.
- The host `container` CLI is trusted administration: an unrestricted root exec bypasses the wrapper and voids this policy.
- Rootfs is read-only. HOME, baseline, workspace, and `/tmp` are tmpfs.
- Host input reaches the guest; cumulative text changes export as a patch while the host file remains unchanged.
- Failed startup removes the partially created container and network.

## Deliberate gap

This is an offline execution proof. Pi has no provider credentials and cannot reach a model. The next experiment must provide model access through a narrow host broker without forwarding durable credentials or reopening general guest networking.
