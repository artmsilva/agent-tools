import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ponytail: models container/network lifecycle and exec-against-a-directory
// well enough to exercise DrydockControlPlane's persistence logic (paths,
// exclusions, atomic rename, cleanup ordering, inspect-confirmed delete
// failures). It does not enforce the real security boundary (uid drop,
// chroot, caps) — that is proven separately by scripts/inside.sh against the
// real Apple `container` CLI.
const FAKE_CONTAINER_CLI =
  "#!/bin/bash\nset -euo pipefail\nSTATE=\"__STATE__\"\nmkdir -p \"$STATE/c\" \"$STATE/n\"\n\nfail() { echo \"$1\" >&2; exit \"${2:-1}\"; }\n\ncmd=\"$1\"; shift || true\n\ncase \"$cmd\" in\n  network)\n    sub=\"$1\"; shift || true\n    case \"$sub\" in\n      create)\n        name=\"${*: -1}\"\n        mkdir -p \"$STATE/n/$name\"\n        ;;\n      delete)\n        name=\"${*: -1}\"\n        [[ -d \"$STATE/n/$name\" ]] || fail \"network not found: $name\"\n        [[ ! -e \"$STATE/n/$name/.force-delete-fail\" ]] || fail \"simulated network delete failure\"\n        rm -rf \"$STATE/n/$name\"\n        ;;\n      inspect)\n        name=\"${*: -1}\"\n        [[ -d \"$STATE/n/$name\" ]] || fail \"network not found: $name\"\n        ;;\n      *) fail \"unknown network subcommand: $sub\" ;;\n    esac\n    ;;\n  create)\n    name=\"\"\n    prev=\"\"\n    for arg in \"$@\"; do\n      if [[ \"$prev\" == \"--name\" ]]; then name=\"$arg\"; fi\n      prev=\"$arg\"\n    done\n    [[ -n \"$name\" ]] || fail \"create requires --name\"\n    mkdir -p \"$STATE/c/$name/root\"\n    ;;\n  start)\n    name=\"$1\"\n    [[ -d \"$STATE/c/$name/root\" ]] || fail \"no such container: $name\"\n    ;;\n  delete)\n    name=\"${*: -1}\"\n    [[ -d \"$STATE/c/$name\" ]] || fail \"no such container: $name\"\n    [[ ! -e \"$STATE/c/$name/.force-delete-fail\" ]] || fail \"simulated container delete failure\"\n    rm -rf \"$STATE/c/$name\"\n    ;;\n  inspect)\n    name=\"${*: -1}\"\n    [[ -d \"$STATE/c/$name\" ]] || fail \"no such container: $name\"\n    ;;\n  exec)\n    name=\"\"\n    workdir=\"/\"\n    args=(\"$@\")\n    rest=()\n    i=0\n    n=${#args[@]}\n    while [[ $i -lt $n ]]; do\n      tok=\"${args[$i]}\"\n      case \"$tok\" in\n        --uid|--gid) i=$((i+2)); continue ;;\n        --workdir) workdir=\"${args[$((i+1))]}\"; i=$((i+2)); continue ;;\n        --interactive|--tty) i=$((i+1)); continue ;;\n        *)\n          if [[ -z \"$name\" ]]; then name=\"$tok\"; else rest+=(\"$tok\"); fi\n          i=$((i+1))\n          ;;\n      esac\n    done\n    rootfs=\"$STATE/c/$name/root\"\n    [[ -d \"$rootfs\" ]] || fail \"no such container: $name\"\n    printf '%s\\n' \"${args[@]}\" > \"$rootfs/.last-exec-invocation\" 2>/dev/null || true\n    [[ ! -e \"$rootfs/.force-exec-fail\" ]] || fail \"simulated exec failure\" 7\n    cwd=\"$rootfs$workdir\"\n    mkdir -p \"$cwd\"\n    m=${#rest[@]}\n    if [[ $m -ge 2 && \"${rest[$((m-2))]}\" == \"-lc\" ]]; then\n      script=\"${rest[$((m-1))]}\"\n      cd \"$cwd\"\n      exec /bin/sh -c \"$script\"\n    else\n      cd \"$cwd\"\n      exec \"${rest[@]}\"\n    fi\n    ;;\n  *)\n    fail \"unknown command: $cmd\"\n    ;;\nesac\n";

/** Writes an executable fake `container` CLI backed by real directories under `stateDir`. */
export async function installFakeContainerCli(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const cliPath = join(stateDir, "container");
  const script = FAKE_CONTAINER_CLI.replace("__STATE__", stateDir);
  await writeFile(cliPath, script);
  await chmod(cliPath, 0o755);
  return cliPath;
}

export function containerRootfsPath(stateDir: string, containerName: string): string {
  return join(stateDir, "c", containerName, "root");
}

/** Path to the marker file that, if present, makes the fake CLI fail a container delete without removing it. */
export function containerForceDeleteFailPath(stateDir: string, containerName: string): string {
  return join(stateDir, "c", containerName, ".force-delete-fail");
}

/** Path to the file the fake CLI writes with one arg per line for the most recent `exec` invocation. */
export function lastExecInvocationPath(stateDir: string, containerName: string): string {
  return join(containerRootfsPath(stateDir, containerName), ".last-exec-invocation");
}
