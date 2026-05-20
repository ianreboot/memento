# memento — Project Instructions

## What This Is

A Claude Code skill/plugin that gives Claude persistent task memory across context compaction.
Hook-based, always-on, invisible to user. Public open-source.

## Architecture Overview

```
SessionStart hook
  └── memento-activate.js
        reads journal → formats → writes to stdout (system context, invisible to user)

UserPromptSubmit hook
  └── memento-tracker.js
        detects /clear → marks mission closed
        emits [MEMENTO active] reminder via hookSpecificOutput (invisible to user)

Claude (during response)
  └── Write tool
        writes journal entries to disk after task completion
        (instructed by SKILL.md — this is the ONLY journal writer)
```

**Key principle**: Hooks are readers and injectors. Claude is the only writer.

## File Structure

| File | Purpose | Edit? |
|------|---------|-------|
| `skills/memento/SKILL.md` | Core behavior: what Claude journals, when, and how | Yes — source of truth |
| `hooks/memento-config.js` | Shared utilities: project tag, safe I/O, formatting, pruning | Yes |
| `hooks/memento-debug.js` | Debug shadow journal — loaded lazily when MEMENTO_DEBUG=1 | Yes |
| `hooks/memento-activate.js` | SessionStart hook — reads journal, injects context | Yes |
| `hooks/memento-tracker.js` | UserPromptSubmit hook — mission lifecycle, per-turn reminder | Yes |
| `hooks/package.json` | CommonJS marker — required for require() in hook scripts | No |
| `hooks/install.sh` | Standalone installer (for non-plugin install path) | Yes |
| `.claude-plugin/plugin.json` | Plugin manifest (used by claude plugin install) | Yes |
| `README.md` | Public-facing documentation | Yes |
| `CONTRIBUTING.md` | Contributor guide | Yes |

## Distribution Models

Memento supports two installation paths — both install the same hooks:

**Plugin path** (recommended):
```
/plugin marketplace add ianreboot/memento
/plugin install memento@ianreboot-memento
```
- Hooks registered automatically via `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory
- No manual settings.json patching needed

**Standalone path**: `curl -fsSL .../install.sh | bash`
- Copies hook files to `~/.claude/hooks/`
- Patches `~/.claude/settings.json` to register hooks
- Useful for users who don't use the plugin system

## Journal Format

State file: `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>.json`

```json
{
  "mission":        "user's request + constraints + done-when (max 400 chars — verbatim, not rewritten)",
  "mission_opened": "ISO timestamp",
  "mission_closed": "ISO timestamp or null",
  "project":        "project-tag",
  "summary":        "rolling summary of pruned entries (max 300 chars) or null",
  "wip":            "mid-task state or blocker string, null if none (max 150 chars)",
  "done": [
    { "act": "string (80ch)", "result": "string (120ch)", "ctx": "string (120ch)", "ts": "ISO" }
  ],
  "plan": ["next step with causal anchor (150ch max)", "..."]
}
```

**Backward compat**: old journals use `completed`/`upcoming`/`task`/`in_progress`/`state`/`state_reason`. These are read transparently and normalized to new names on next write. No migration needed.

## Design Principles

1. **Claude writes, hooks inject** — hooks cannot observe task completion; only Claude can
2. **Fidelity over completeness** — only record what was stated or observed; never infer
3. **Compress format, not facts** — terse notation, exact technical terms
4. **Invisible to user** — no chat output, no status messages from hooks
5. **Background performance** — hooks return instantly; all I/O is minimal
6. **Silent failure** — hooks must never block session start or user prompts
7. **Complement, not replace** — fills the gap between CLAUDE.md, MEMORY.md, and conversation history
8. **Security** — atomic writes, symlink-safe I/O, 0600 permissions, 6KB size cap

## Rolling Window Parameters

| Parameter | Value | Override |
|-----------|-------|---------|
| Max done entries | 6 | `MEMENTO_MAX_ENTRIES` (range 4–24) |
| Max plan items | 3 | — |
| Summary max chars | 300 | — |
| Journal file size cap | 6KB | `MEMENTO_MAX_FILE_KB` |
| Staleness threshold | 7 days (active: 14d) | `MEMENTO_STALE_DAYS` |
| Instance tag override | (OS username) | `MEMENTO_INSTANCE_TAG` |

## Testing

**Run tests before every push — no exceptions:**
```bash
bash tests/run.sh
```

All 3 test files run automatically (`test_journal_utils.js`, `test_hooks.js`, `test_activate.js`). If any fail, fix before pushing. Do not push and wait for CI to surface failures that a local run would catch in seconds.

## Key Rules for Contributors

- **Edit `skills/memento/SKILL.md`** for behavior changes. This is the single source of truth.
- **Hook files must silent-fail** on all filesystem errors. No exceptions.
- **All journal writes must be atomic** (temp file + rename). Use `writeJournal()` from `memento-config.js`.
- **Never add user-visible output** to hooks. System context injection only.
- **Respect `CLAUDE_CONFIG_DIR`** env var. Never hardcode `~/.claude`.
- **Any new file write** must go through `writeJournal()` — do not use `fs.writeFileSync` directly on the journal path (reopens the symlink-clobber attack surface).
- **README is public-facing** — keep it accurate and jargon-light. Document all behavior changes there.

---

## v0.3.0 Roadmap

These items are confirmed for v0.3.0. Do not implement them in patch releases — they require
architectural changes or schema changes that need coordinated design.

### A — Hook-level mission nudge at recovery start
**Source**: `real-world-review-8537-session.md`, `real-world-review-ian-brain-dedup-compaction.md`
**Problem**: When a session starts via compaction (`source: "compact"` or `"resume"`) with no
active mission, C4's SKILL.md trigger #7 doesn't fire because there is no decision point before
work begins — the user's first message is already a continuation task. The no-mission gap persists
structurally.
**Fix**: In `memento-activate.js`, when `source` is `"compact"` or `"resume"` AND the journal
has no active mission (`mission_closed` is set or journal doesn't exist), inject a one-time
additional line after the standard header:
```
Consider journaling current task state (wip) before proceeding — no active mission is open.
```
This fires at the exact moment the gap occurs (post-compaction start, no mission) and gives
the recovering Claude a hook to act on before the first task runs.

### B — Project-switch stale mission detection
**Source**: `project-switch-mission-staleness.md`
**Problem**: When a user switches projects without `/clear`, the hook auto-updates `journal.project`
to the current git project, but `mission` stays set to the previous project's work.
`mission_closed` remains null. The next session injects the stale mission as if it's current.
**Fix**: In `memento-activate.js`, on SessionStart: if `mission_closed=null` but `journal.project`
(before auto-update) differs from the detected project tag, add a stale-mission warning to the
injection header:
```
[MEMENTO] Mission: <old mission> | proj:<new project> | path:...
Warning: mission may be from a different project — verify before acting on it.
```
Requires tracking the pre-update project value before `journal.project` is overwritten.

### C — Bare wip writes without a mission field (schema relaxation)
**Source**: v0.2.4 design — deferred from C4 rationale
**Problem**: The journal schema assumes a `mission` field as precondition for all writes. When
`mission_closed` is set and no new mission is opened, SKILL.md tells Claude to write a bare `wip`
entry, but every structural cue in the schema (mission, mission_opened, done[]) is mission-scoped.
This creates an implicit precondition that text instructions fight but don't eliminate.
**Fix**: Allow a journal write where `mission` is null or `"[pending]"` and only `wip` is set.
Hook injection for this state: show `wip` content without a mission header. Schema change — needs
careful thought on what pruning and stale-collapse do with a no-mission journal.

### D — Auto-checkpoint near compaction threshold
**Source**: `real-world-review-ian-brain-dedup-compaction.md`
**Problem**: Long in-progress sessions heading toward compaction don't automatically checkpoint
current task state. If the conversation summary is thin or truncated, the recovering Claude has
no memento context for what was in flight.
**Fix**: If a `PreCompact` hook event type becomes available, trigger a journal write with current
`wip` state before compaction fires. Currently speculative — no such hook event exists in Claude
Code. Track the hook API for changes. Do not implement a workaround that polls context size.

### E — Per-project journals
**Source**: architectural — deferred from v0.2.x planning
**Problem**: Single journal per instance means cross-project sessions always surface a previous
project's mission. The `subject` field and cross-project suppression are workarounds. Root fix
is one journal file per project.
**Fix**: Change `getJournalPath()` to derive path from `${instanceTag}-${projectTag}.json`.
Cascading changes: pruning, stale-collapse, injection (no project mismatch possible), SKILL.md
(journal path derivation changes), install docs. Largest change in any v0.x release — design
carefully before starting.

### F — New feedback from v0.2.4 soak
Collect session observations after v0.2.4 is running. Add new feedback docs to
`memento-internal/docs/feedback/` as usual. Assess before cutting the v0.3.0 plan.

---

### Items NOT in v0.3.0 (resolved or accepted)

| Item | Resolution |
|------|-----------|
| External journal modification causing field drift | Accept as feature — user edits are the escape hatch. Document in README. |
| Plugin cache path instability (userpromptsubmit-hook-error) | C3 detects stale paths. Add README note that standalone install is more stable than plugin install. |
| ctx quality (2/8 entries had ctx in marathon session) | Behavioral — no structural fix available. Track in soak sessions. |
