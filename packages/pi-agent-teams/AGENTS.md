# Package instructions

## Scope

Hardened Pi agent-team control plane. The lead session stays conversational while background teammates share tasks and mailboxes. Teammates run in visible Herdr panes; `auto` starts Herdr in Ghostty when needed, with explicit/headless RPC retained for CI and hard bootstrap failures.

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
- `displayMode: auto` must start a visible named Herdr session in Ghostty when Herdr is unavailable, then fall back to RPC only after a clear bootstrap failure. Explicit `herdr` mode must fail clearly rather than silently changing runtime.
- Source-changing teammates default to worktrees. Never automatically remove dirty/unverifiable worktrees or local branches.
- Agent definitions may narrow tools but never grant tools unavailable to the leader. `readonly: true` removes `bash`, `edit`, and `write`.
- Keep concurrency bounded. Workers do not receive the leader-only `teams` tool, preventing nested team fan-out.
- Never infer task success from assistant prose. Workers must submit `team_task_result` with concrete evidence; quality-gate hooks remain the independent verifier.
- Stall recovery is bounded: checkpoint, one retry by default, then `needsHuman`. Never build an unbounded autonomous retry loop.
- Preserve the upstream MIT license and update `UPSTREAM.md` when rebasing from upstream.
