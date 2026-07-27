# Package instructions

## Scope

Pi extension that runs pi's file/shell tools inside a Gondolin micro-VM with locked egress, an interactive allowlist, read-only skill mounts, and dotfile provisioning.

## Validation

```sh
npm run check
```

No test script exists for this package (`package.json` defines only `check`, `install-extension`, `build-image`).

## Guardrails

- Unknown hosts **fail closed** when there is no interactive UI (print/json/headless modes) — `AllowList.check` denies by design rather than silently allowing (`src/allowlist.ts`).
- `blockInternalRanges` is always on and `allowedHosts` is intentionally left `undefined` so Gondolin's built-in host check no-ops in favor of the dynamic allowlist callback (`src/http-gate.ts`) — don't reintroduce a static host list there.
- Secrets (GitHub token) are injected host-side only for a fixed `GITHUB_SECRET_HOSTS` list; the guest only ever sees an opaque placeholder, never the real token.
- Only `/workspace` (host cwd), the shared linked-worktree `.git` common dir, and read-only skill/skel paths are mounted — the rest of `$HOME` is deliberately never mounted (`src/mounts.ts`) to keep SSH keys, `auth.json`, and secrets env files off the guest.
- Guest git is hardened at provision time (`gc.auto=0`, `safe.directory '*'`) specifically so a shared/linked worktree's host repo can't be pruned or rejected from inside the guest (`src/provision.ts`).
- Telemetry milestones are a fixed ordered set (`extension_loaded → session_start → vm_boot_start → vm_created → provisioned → vm_ready → first_prompt`) written to `~/.pi/agent/gondolin/telemetry.jsonl`; disable via `GONDOLIN_TELEMETRY=0`, don't rename existing mark names since downstream `jq` analysis depends on them.
