# Drydock

Drydock is a named local environment where an AI agent can work without receiving authority over the host computer. Its identity and filesystem outlive individual processes and conversations.

## Language

**Drydock**:
A named environment with durable identity, durable guest files, and disposable compute.
_Avoid_: Sandbox invocation, container, tool runner

**Control plane**:
The trusted host side that owns lifecycle, policy, connectors, checkpoints, and handoff.
_Avoid_: Host scripts, operator UI

**Guest**:
The isolated Linux environment where Pi and all work execute.
_Avoid_: Sandbox process, tool VM

**Workspace**:
The guest-owned project filesystem that provides continuity between sessions.
_Avoid_: Host checkout, mounted repository

**Guest shell**:
One terminal-owned shell inside an active Drydock. The user may start and exit Pi repeatedly; exiting the shell ends foreground work before hibernation.
_Avoid_: Session, daemon, background job

**Conversation**:
A durable Pi interaction record stored in the Guest outside the workspace. It can resume in a new foreground run without preserving the old process.
_Avoid_: Process, terminal session

**Task lease**:
A declaration that work is active and the Drydock must not hibernate.
_Avoid_: Keepalive, sleep blocker

**Hibernation**:
Removal of active compute while retaining durable guest files and identity. It does not preserve processes, memory, or connections.
_Avoid_: Pause, suspend

**Checkpoint**:
A deliberate, restorable point in the durable guest filesystem.
_Avoid_: Git commit, backup

**Connector**:
A host-managed route to one external capability that keeps its durable credential outside the Guest. Its short-lived access grant is issued by the control plane and renewed after wake.
_Avoid_: Credential mount, open egress, proxy

**Policy**:
Host-owned constraints on what a Drydock may access or change. The Guest may inspect policy but cannot grant itself more authority.
_Avoid_: Guest configuration

**Handoff**:
A reviewed patch or selected artifact transferred from a Drydock to the host.
_Avoid_: Shared mount, automatic sync
