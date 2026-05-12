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

## Key Rules for Contributors

- **Edit `skills/memento/SKILL.md`** for behavior changes. This is the single source of truth.
- **Hook files must silent-fail** on all filesystem errors. No exceptions.
- **All journal writes must be atomic** (temp file + rename). Use `writeJournal()` from `memento-config.js`.
- **Never add user-visible output** to hooks. System context injection only.
- **Respect `CLAUDE_CONFIG_DIR`** env var. Never hardcode `~/.claude`.
- **Any new file write** must go through `writeJournal()` — do not use `fs.writeFileSync` directly on the journal path (reopens the symlink-clobber attack surface).
- **README is public-facing** — keep it accurate and jargon-light. Document all behavior changes there.
