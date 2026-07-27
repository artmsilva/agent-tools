# Session medic

## Language

**Poisoned session**:
A saved conversation containing material that a provider rejects when the conversation is replayed, preventing further turns.
_Avoid_: Corrupted session, broken session

**Poison pattern**:
A known category of replay-incompatible content, such as invalid error content, oversized media, or an orphaned tool reference.
_Avoid_: Bad request, API error

**Repair**:
A durable rewrite that removes or replaces poisoned content so the conversation can be replayed safely.
_Avoid_: Cleanup, retry

**Tombstone**:
A text record left where non-replayable content was removed, preserving what happened without preserving the rejected payload.
_Avoid_: Placeholder, stub
