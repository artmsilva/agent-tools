---
status: accepted
---

# Make the durable environment the core model

Drydock began as an ephemeral adapter that moved individual Pi tool calls into fresh Apple containers. The Pi-inside proof and the Sprites model showed a deeper fit: agent work needs a stable computer-like identity, filesystem continuity, reconnectable sessions, externally owned policy, and recovery—not merely isolated command execution. Drydock will therefore be a named durable environment whose guest filesystem survives conversations and hibernation while compute, processes, memory, and connections remain disposable.

The trusted host control plane owns lifecycle, policy, connectors, checkpoints, and reviewed handoff. Pi and all project work run in the Guest. Provider credentials remain in host-managed Connectors and never become Guest files. The Guest may inspect its effective policy and create scoped checkpoints, but cannot widen policy or acquire host authority.

The ephemeral `drydock_bash` adapter was removed before release because it had no consumers and contradicted the durable environment interface. `inside.sh` remains only as proof history. The supported `drydock` CLI manages named environments without exposing container mechanics.

## Consequences

- Filesystem continuity, not process continuity, is the durable contract.
- Hibernation must wait for attached sessions, running commands, broker requests, or task leases to finish.
- Cold wake starts new processes and requires clients to reconnect.
- Persistence must be atomic, crash-safe, and exclude host credentials and shared Git metadata.
- Apple `container` is the current implementation, not part of the caller-facing model. A second runtime would justify a runtime adapter seam; one runtime does not.
- No companion app is selected. Any future app must use the control-plane interface and cannot define security policy.
