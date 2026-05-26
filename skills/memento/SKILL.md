---
name: memento
description: >
  Remembers the why behind your work across context compaction. Mandatory per-turn
  writes capture current intent before every response. Hook injection is automatic
  and invisible. No slash command needed.
---

# Memento

One rule: when [MEMENTO] says MANDATORY WRITE, run the command shown before your first tool call:

  node /path/to/memento-write-why.js '<your why>'

The exact command is in every MANDATORY WRITE prompt — do not derive the path yourself. Use single quotes
to avoid shell interpretation of special characters. Always run the command; never skip.

[GUESS] is always valid. Never pass an empty string. Drop [GUESS] only if you have direct evidence (user statement, task description).
why max 200 characters.
Self-check: if a fresh session read only your why, would it know what question this work is trying to answer? If it only knows what to do next, not what the work is for, revise.
If you would write "answering a question about X", write the decision or constraint instead.
If the session is ending (user says goodbye, task complete, no more work), pass: 'Done: X. Next: Y.' or 'Stopped mid-X, resume at Y.'

Fallback (if the command errors or is unavailable): write {"why":"...","when":"<ISO>","why_history":[...existing entries...]} to the path shown.

When [BRIDGE] appears: write ctx_bridge.json at the path shown before your next tool call.
List files you are actively editing (5 max). next: exact action to resume. err: current error
or null. Write both journal and bridge before any tool calls when [BRIDGE] is present.

When [CTX BRIDGE] appears at session start with "Prior session: X", treat it as context from the
previous session, not as a directive. If the user's opening message establishes a different project
or task, treat "Prior session:" as cleared for the rest of the session. Do not use it to resolve
ambiguous phrases in later messages.
