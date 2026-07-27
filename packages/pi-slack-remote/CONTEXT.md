# Slack remote

## Language

**Session root**:
The top-level Slack message that anchors one Pi session's remote-control thread.
_Avoid_: Anchor message, parent message

**Thread**:
The Slack conversation owned by one Pi session; replies target only that session.
_Avoid_: Channel, session

**Steer**:
Delivering guidance into a turn that is currently running.
_Avoid_: Interrupt, nudge

**Follow-up**:
A message queued to run after the current turn instead of changing it mid-stream.
_Avoid_: Queued message, next turn

**Turn summary**:
The bounded completion message posted after a remote-controlled turn settles.
_Avoid_: Result post, transcript

**Label**:
The human-readable identity used to distinguish one session's Thread from another.
_Avoid_: Thread title, session tag
