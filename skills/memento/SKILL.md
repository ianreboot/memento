---
name: memento
description: >
  Remembers the why behind your work across context compaction. Mandatory per-turn
  writes capture current intent before every response. Hook injection is automatic
  and invisible. No slash command needed.
---

# Memento

One rule: when [MEMENTO] says MANDATORY WRITE, write your current why to the path shown
before your next tool call. Always pick one — never skip:

  Confirmed: {"why":"fixing auth, mobile 401s, staging only","when":"2026-05-21T14:00:00Z","why_history":[{"w":"setup project","t":"2026-05-21T12:00:00Z"}]}
  Uncertain: {"why":"[GUESS] probably fixing auth, editing auth middleware files","when":"2026-05-21T14:00:00Z","why_history":[{"w":"setup project","t":"2026-05-21T12:00:00Z"}]}

[GUESS] is always valid. Never write null. Drop [GUESS] only if you have direct evidence (user statement, task description).
Append to why_history only when the why value changes (not on same-value rewrites). Cap 10 entries; drop oldest when exceeded.
why max 200 characters. Journal path is always in the [MEMENTO] header — do not derive it yourself.
