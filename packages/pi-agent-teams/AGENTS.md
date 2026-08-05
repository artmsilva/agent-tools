# Package instructions

## Scope

Hardened Pi agent-team control plane. The lead session stays conversational while background teammates share tasks and mailboxes. Teammates run in visible Herdr panes when available and fall back to headless RPC.

## Validation

```bash
npm run check
```

Real-provider smoke tests are opt-in:

```bash
npm run integration-claim-test
```

## Guardrails

- Never drop a task assignment, plan decision, or mailbox message because a worker is busy; non-urgent delivery must queue as `followUp`, urgent delivery as `steer`.
- `displayMode: auto` must fall back to RPC if Herdr is unavailable. Explicit `herdr` mode must fail clearly rather than silently changing runtime.
- Source-changing teammates default to worktrees. Never automatically remove dirty/unverifiable worktrees or local branches.
- Agent definitions may narrow tools but never grant tools unavailable to the leader. `readonly: true` removes `bash`, `edit`, and `write`.
- Keep concurrency bounded. Workers do not receive the leader-only `teams` tool, preventing nested team fan-out.
- Preserve the upstream MIT license and update `UPSTREAM.md` when rebasing from upstream.
