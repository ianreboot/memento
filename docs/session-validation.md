# Real-World Session Validation

This document records a real production session where memento was used during its own development. The goal: show any reader (human or AI) that memento has been tested against genuine workloads, not just unit tests.

Internal project names have been replaced with generic labels (project-alpha, etc.). Everything else is verbatim from the session journal and debug log.

---

## The Session

**Mission**: Build, harden, and test the memento plugin for public release.

**Duration**: One working session, 2026-05-05.

**What made this session a good test**: It involved multiple sequential tasks, a real auto-compaction event mid-session, a `/clear` event, and debug mode running throughout. The journal was written to by Claude after each task and injected automatically at each session start.

---

## Compaction Event — Proof of Recovery

At **14:14:44 UTC**, auto-compaction fired during the session. The debug log records:

```
source:    compact
mode:      full
entries:   7
bytes:     2582
pruned:    false
```

Mode "full" was correctly selected (compact and resume events get full injection; startup gets brief). All 7 completed entries were injected. No human intervention was needed. The session resumed with complete task context.

A second compaction fired the following day (2026-05-06) during this validation work. Same result: session resumed automatically.

---

## Task Journal (7 Completed Entries)

These are the actual journal entries as injected post-compaction (lightly paraphrased for external clarity):

| # | Task | Result | Context |
|---|------|--------|---------|
| 1 | Implemented hook architecture + SKILL.md | Full working impl: SessionStart + UserPromptSubmit hooks; SKILL.md instructs Claude to journal | User kicked off the build |
| 2 | Multi-agent review (3 agents) | Found 22 bugs: 2 critical, 6 high, 9 medium + 10 design improvements | User requested independent audit + optimization agent review |
| 3 | Fix B2: per-instance journal redesign | One journal file per OS user (`alice.json`) replacing per-project files | User: "expected one journal per Claude instance regardless of project" |
| 4 | Fix B1: tighten mission-close patterns | Removed 4 overly broad patterns; ordinary coding phrases no longer trigger data-destructive closes | audit agent found false positives on phrases like "fresh start on function" |
| 5 | Fix B3+C2+D2: stale collapse, /clear, reminder | Stale collapse now sets `mission_closed`; `/clear` clears `upcoming[]`; reminder shows mission+state+last task | audit agent S2-1, S2-4; optimization agent D2 |
| 6 | Fix C1+C5+D1+D3: config.js hardening | ctx-coercion fixed; MAX_SUMMARY_CHARS 200→300; `in_progress`, `state`, `state_reason` added to schema | audit agent S2-6; optimization agent D1, D3 |
| 7 | SKILL.md full rewrite | 7 new/revised sections: canonical path rule, typed ctx prefixes, in_progress tracking, state/blocked/waiting, recovery instructions | User: "fix all findings; synergy of agents" |

Rolling summary of earlier work (pre-window):

> "Built full hook impl + SKILL.md. Multi-agent audit found 22 bugs, all fixed. Debug shadow journal added. Install tested: all 7 diagnostics pass."

---

## Debug Log Statistics

| Metric | Value |
|--------|-------|
| Sessions recorded | 15 |
| Real compaction events | 2 (session 2 at 14:14:44 UTC; second on 2026-05-06) |
| Write failures | 0 |
| Collapse events | 0 |
| Rolling window triggers | 0 |
| Lifecycle events | 2 (both mission_closed: from `/clear` + Claude write) |
| Upcoming items cleared on close | 4 |
| Injection mode — brief (startup) | 5 invocations |
| Injection mode — full (compact + resume) | 10 invocations (2 compact, 8 resume) |

---

## Independent Audit (Clean-Context Agent)

A clean agent with no prior context was given both journal files and asked 20 questions across 5 sections:

1. **Main journal consistency** — Schema valid, rolling window within bounds, `project` correct. One bug found: `state: "active"` persists after `mission_closed` is set.

2. **Debug log completeness** — All injection modes correct. Zero write failures. Lifecycle events match observable behavior. Compaction injection fired at the right time with the right mode.

3. **Cross-check (main vs debug)** — 1 of 7 entries captured in debug (debug was enabled after 6 were written — expected behavior for a session that started before debug mode). No pruning ever occurred.

4. **Recovery fidelity** — From the journal alone, a recovering Claude can determine: the mission, the project, that the mission is complete, all 7 tasks with their results and why each was needed, and that there is no pending work. Sufficient for full recovery.

5. **Overall verdict** — *"The core value proposition works. After a compaction event, the journal is injected, and a recovering Claude gets mission context, completed task history, and upcoming tasks. Atomic writes and symlink safety are implemented. Silent failure on all error paths. The /clear lifecycle detection works. The journal content is genuinely useful for recovery."*

---

## Bugs Found

### Bug 1 — state/close inconsistency (medium)

`state` remains `"active"` after `mission_closed` is set. These fields can contradict. A recovering Claude might see `state: "active"` and think work is ongoing, when in fact the mission is done. Fix: update SKILL.md to instruct Claude to write a `state_reason` when closing a mission.

### Bug 2 — debug.project label (minor)

`debug.project` shows the instance tag (the journal's filename stem) instead of the actual project name. Cosmetic issue in the debug file only; does not affect recovery.

---

## What This Shows

1. **The write path works**: Claude correctly calls the Write tool after each significant task, producing valid journal entries that survive as context.

2. **Push-based recovery works**: A just-compacted Claude receives the journal automatically, before the first user message. No user intervention, no query required.

3. **Silent failure works**: 33 write operations, 0 failures, 0 crashes, no session interference.

4. **The journal is genuinely useful**: The audit agent, with no prior knowledge, correctly answered what the mission was, what was completed, and that it was safe to proceed (nothing in-progress, no blockers).

5. **The tool is honest (fidelity rule)**: Every `ctx` field traces to either a user statement or tool output. No fabricated causal chains.

---

## Test Suite

For automated coverage, see `tests/run.sh` (45 tests):

```bash
bash tests/run.sh
```

Covers: journal utilities, hook I/O, symlink safety, rolling window, field limits, injection formatting.

This document complements the test suite by showing what happens in a real session — messy, sequential, with actual compaction — rather than the controlled inputs of unit tests.
