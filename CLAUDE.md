# memento — Project Instructions

## What This Is

A Claude Code skill/plugin that gives Claude persistent task memory across context compaction.
Hook-based, always-on, invisible to user. Public open-source.

## Architecture Overview

```
SessionStart hook
  └── memento-activate.js
        reads journal → resets turn sidecar → injects ctx_bridge if present (any source)
        writes MANDATORY WRITE prompt to stdout (invisible to user)

UserPromptSubmit hook
  └── memento-tracker.js
        reads turn sidecar → emits MANDATORY WRITE prompt (T1 full or T2+ compressed, invisible to user)
        increments turn sidecar
        at ≥74% ctx: emits [BRIDGE] directive → Claude writes ctx_bridge.json
        on ctx% drop ≥20pp: reads ctx_bridge.json → injects [CTX BRIDGE] block → deletes file

PreCompact hook
  └── memento-precompact.js
        emits "MANDATORY WRITE — LAST WRITE OPPORTUNITY" to stdout (invisible to user)
        writes ctx_bridge.json via claude -p AI extraction (skips if tracker bridge exists)

SessionEnd hook
  └── memento-sessionend.js
        writes minimal ctx_bridge.json from journal.why (skips if any bridge exists)
        no stdout — session is ending

Claude (during response)
  └── Write tool
        writes {why, when, why_history} to journal path before first tool call
        writes ctx_bridge.json when [BRIDGE] directive appears
        (instructed by SKILL.md — Claude is the only journal writer)
```

**Key principle**: Hooks are readers and injectors. Claude is the only journal writer.
Bridge writes come from three sources (Claude via [BRIDGE] directive, PreCompact hook,
SessionEnd hook) — only the richest available bridge is used.

## File Structure

| File | Purpose | Edit? |
|------|---------|-------|
| `skills/memento/SKILL.md` | Core behavior: mandatory write rule, [GUESS] mechanic, why_history rule | Yes — source of truth |
| `hooks/memento-config.js` | Shared utilities: instance/project tag, safe I/O, journal normalization, turn sidecar path | Yes |
| `hooks/memento-debug.js` | Debug shadow journal — loaded lazily when MEMENTO_DEBUG=1 | Yes |
| `hooks/memento-activate.js` | SessionStart hook — reads journal, resets turn sidecar, injects prompt | Yes |
| `hooks/memento-tracker.js` | UserPromptSubmit hook — emits per-turn MANDATORY WRITE prompt, increments sidecar | Yes |
| `hooks/memento-precompact.js` | PreCompact hook — emits last-write-opportunity prompt + writes ctx_bridge via claude -p | Yes |
| `hooks/memento-sessionend.js` | SessionEnd hook — writes minimal ctx_bridge from journal.why on session exit | Yes |
| `hooks/memento-write-why.js` | Journal write helper — Claude runs this via Bash instead of Write tool; atomic writes, history management | Yes |
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

State file: `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>-<conversation-hash>.json`

```json
{
  "why":         "current intent (max 200 chars) — may start with [GUESS]",
  "when":        "ISO 8601 — timestamp of last write",
  "why_history": [
    {"w": "previous why value", "t": "ISO 8601"}
  ]
}
```

Session anchor: `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>.anchor` — stores active JSONL path; written by SessionStart, read by all subsequent hooks.

Turn sidecar: `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>.turn` — plain integer, fixed per-instance path (no hash); reset each session by SessionStart hook.

ctx_bridge: `$CLAUDE_CONFIG_DIR/.memento/ctx_bridge-<conversation-hash>.json` — per-conversation recovery snapshot.

**Conversation hash**: 8-char SHA-1 of the active JSONL file path (unique per conversation, isolates parallel sessions on the same project). Override with `MEMENTO_PROJECT_HASH` env var for testing or non-git contexts. Falls back to `getProjectHash()` (SHA-1 of git root) when no JSONL is found.

**Schema validation**: `readJournal()` returns null for any journal without a `why` field (includes all pre-v0.4.0 journals). Null triggers a fresh-start prompt; Claude creates a new journal at the namespaced path.

## Architecture Note: Why the PreCompact Hook Uses a `claude -p` Inference Call

The PreCompact hook is a shell process. Claude Code calls it before compaction, reads its stdout as a prompt injection, then proceeds with compaction. The hook runs and exits — it cannot wait for Claude to respond, and Claude may not be able to use tool calls during compaction ("tool use may not be available during compaction" is documented in the hook source).

The only way to write `ctx_bridge.json` with rich structured data (files, next step, error) at the PreCompact boundary — when no tracker bridge exists — is to spawn a separate `claude -p` process that reads the session transcript tail and extracts recovery state. Without this call, the only fallback is the minimal bridge from `journal.why` (no files, no structured next step), which is the same low-fidelity bridge SessionEnd writes.

This is not overhead that can be removed. It is architecturally load-bearing. The hook system is one-way: hooks write to stdout (prompt injection) and exit. There is no mechanism for a hook to wait for Claude to respond or write files. `claude -p` is the only way to perform AI extraction at compaction time.

## Design Principles

1. **Claude writes, hooks inject** — hooks cannot observe task completion; only Claude can
2. **Mandatory writes** — every turn is a write opportunity; [GUESS] is always valid so Claude never skips
3. **Invisible to user** — no chat output, no status messages from hooks
4. **Background performance** — hooks return instantly; all I/O is minimal
5. **Silent failure** — hooks must never block session start or user prompts
6. **Complement, not replace** — fills the gap between CLAUDE.md, MEMORY.md, and conversation history
7. **Security** — atomic writes, symlink-safe I/O, 0600 permissions, 6KB size cap

## Journal Parameters

| Parameter | Value | Override |
|-----------|-------|---------|
| `why` max chars | 200 | — |
| `why_history` max entries | 10 | — |
| Journal file size cap | 6KB | `MEMENTO_MAX_FILE_KB` |
| Instance tag override | (OS username) | `MEMENTO_INSTANCE_TAG` |
| Conversation hash override | (SHA-1 of JSONL path) | `MEMENTO_PROJECT_HASH` |

## Testing

**Run tests before every push — no exceptions:**
```bash
bash tests/run.sh
```

All 3 test files run automatically (`test_journal_utils.js`, `test_hooks.js`, `test_symlink_safety.js`). If any fail, fix before pushing. Do not push and wait for CI to surface failures that a local run would catch in seconds.

## Key Rules for Contributors

- **Edit `skills/memento/SKILL.md`** for behavior changes. This is the single source of truth.
- **Hook files must silent-fail** on all filesystem errors. No exceptions.
- **All journal writes must be atomic** (temp file + rename). Use `writeJournal()` from `memento-config.js`.
- **Never add user-visible output** to hooks. System context injection only.
- **Respect `CLAUDE_CONFIG_DIR`** env var. Never hardcode `~/.claude`.
- **Any new file write** must go through `writeJournal()` — do not use `fs.writeFileSync` directly on the journal path (reopens the symlink-clobber attack surface).
- **README is public-facing** — keep it accurate and jargon-light. Document all behavior changes there.

