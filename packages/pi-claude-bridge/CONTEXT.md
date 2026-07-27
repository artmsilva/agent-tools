# Claude bridge

## Language

**Bridge**:
The boundary that makes Claude Code resources available to Pi while preserving their source and behavior.
_Avoid_: Importer, compatibility shim

**Source**:
The provenance scope a resource came from: project, user, or plugin.
_Avoid_: Location, folder

**Resolved plugin**:
An enabled plugin whose active installation has been located and can supply resources to the bridge.
_Avoid_: Installed package, plugin cache

**Managed agent link**:
A bridge-owned projection of a Claude agent definition into Pi. Only bridge-owned links may be changed or retired by the bridge.
_Avoid_: Copied agent, imported agent

**Hook mapping**:
The translation between a Claude lifecycle event and the corresponding Pi lifecycle event, including its control semantics.
_Avoid_: Hook forwarding, event alias

**Collision-skip**:
Leaving an existing higher-priority Pi resource untouched when a bridged resource has the same name.
_Avoid_: Override, merge
