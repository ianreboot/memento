# Contributing to memento

Memento is open source and welcomes contributions. This document explains how the project works, how to set up a development environment, and what to keep in mind when submitting changes.

## How Memento Works

Memento has three components that work together:

### 1. The SKILL.md (`skills/memento/SKILL.md`)

This is loaded into Claude's context at every session start (the skill is always active). It instructs Claude on:
- The MANDATORY WRITE rule: write `{why, when, why_history}` before every response
- When [GUESS] is valid (always) and when to drop it (only on direct evidence)
- When to update `why_history` (only when `why` changes)

**Claude is the only journal writer.** The SKILL.md is what makes Claude write. If you want to change what gets journaled or how, edit SKILL.md.

### 2. The hooks (`hooks/`)

Four hooks run automatically on every Claude Code session:

**`memento-activate.js`** (SessionStart):
- Reads the journal for the current instance
- Resets the turn counter sidecar (0 for fresh start, 1 for recovery)
- Reads and deletes `ctx_bridge.json` if present — file existence is the signal regardless of `source`
- Writes to stdout — Claude Code injects this as hidden system context
- Recovery prompt on `source: "compact"` or `"resume"`. Turn 1 prompt on `source: "startup"`.
- Bridge content (`[CTX BRIDGE]` block) prepended to the prompt when a bridge is present

**`memento-tracker.js`** (UserPromptSubmit):
- Reads the turn counter sidecar
- Emits a MANDATORY WRITE prompt: full format on Turn 1, compressed on Turn 2+
- Increments the turn counter
- At ≥74% context: appends a `[BRIDGE]` directive — Claude writes `ctx_bridge.json` with files, next step, and current error
- On context drop ≥20pp (signals post-compaction recovery): injects the bridge as `[CTX BRIDGE]` and deletes the bridge file
- This prompt is invisible to the user

**`memento-precompact.js`** (PreCompact):
- Fires before context compaction
- Emits "MANDATORY WRITE — LAST WRITE OPPORTUNITY" to stdout
- Always fires — gives Claude one final chance to capture current intent before the compaction window closes
- Also writes `ctx_bridge.json` via `claude -p` AI extraction from the session transcript tail. Falls back to `journal.why` if AI extraction fails. Skips if a richer tracker bridge already exists.

**`memento-sessionend.js`** (SessionEnd):
- Fires when the Claude Code session ends (clean exit, crash, or interrupt)
- Writes a minimal `ctx_bridge.json` from `journal.why` — covers sessions that exit without compacting
- Does not spawn subprocesses (runs in milliseconds to avoid blocking session exit)
- Skips if a richer bridge already exists from the tracker or PreCompact hook
- No stdout output (session is ending; nothing to inject)

**`memento-write-why.js`** (journal write helper — invoked by Claude via Bash):
- Called as `node memento-write-why.js '<why string>'` — Claude runs this instead of using the Write tool
- Reads the existing journal, manages `why_history` (append on change, cap at 10), writes via `writeJournal()`
- Eliminates the Read-before-Write requirement of the Write tool (3 tool calls → 1 Bash call per journal write)
- Routes all writes through `writeJournal()` — atomic temp+rename, symlink-safe (fixes KNOWN_ISSUES #2)
- Silent-fail on any error; no stdout output

**`memento-config.js`** (shared utilities):
- Instance tag: `getInstanceTag()` → OS username → "default" (journal file path; override with `MEMENTO_INSTANCE_TAG`)
- Project tag: `getProjectTag()` → git root basename → cwd basename → "default" (informational only; common names blocklisted)
- Project hash: `getProjectHash()` → 8-char SHA-1 of git root path → SHA-1 of cwd → "default" (namespaces all per-project files; override with `MEMENTO_PROJECT_HASH`)
- Turn sidecar path: `getTurnSidecarPath(journalPath)` → replaces `.json` with `.turn`
- `readJournal()` — symlink-safe, size-capped JSON read; returns null for any journal without a `why` field
- `writeJournal()` — atomic temp+rename, symlink-safe, 0600 permissions; normalizes and caps `why` and `why_history`
- `sanitizeLine()` — collapses newlines and excess whitespace in string fields
- `WRITE_SCRIPT_PATH` — absolute path to `memento-write-why.js` (hooks embed this in MANDATORY WRITE prompts)
- Constants: `MAX_WHY_CHARS` (200), `MAX_WHY_HISTORY` (10), `MAX_JOURNAL_BYTES`, `BRIDGE_TRIGGER_PCT` (74), `CTX_DROP_THRESHOLD` (20)
- Bridge utilities: `getCtxBridgePath(claudeDir, projectHash)`, `writeCtxBridge`, `readCtxBridge`, `deleteCtxBridge`
- JSONL utilities: `findLatestJsonl`, `readLastUsage`, `getLastCtxPath`, `readLastCtxPct`, `writeLastCtxPct`

### ctx_bridge

In addition to the journal (`why` + history), memento writes a structured recovery snapshot at `~/.claude/.memento/ctx_bridge-{projectHash}.json` before the session ends. Three hooks can write this file (only the first/richest write wins):

1. **Tracker at 74%+**: Claude writes the bridge directly in response to the `[BRIDGE]` directive — richest content (Claude has full knowledge of files in progress, exact next step, current error).
2. **PreCompact hook**: Uses `claude -p` AI extraction from the JSONL transcript tail — catches cases where the tracker directive was not actioned (e.g. compaction fired mid-turn between tracker checks).
3. **SessionEnd hook**: Writes `{ next: journal.why, files: [] }` directly — minimal but reliable fallback for sessions that exit cleanly without compacting.

At the next session start, `memento-activate.js` injects the bridge into the recovery prompt and deletes the file.

### Hook definition file

Two files define the plugin install path:

- **`.claude-plugin/plugin.json`** — plugin manifest (hooks, metadata)
- **`.claude-plugin/marketplace.json`** — marketplace catalog (required for `/plugin marketplace add ianreboot/memento`)

The standalone installer (`hooks/install.sh`) does not use this file — it patches `~/.claude/settings.json` directly with inline Node.js.

### 3. The journal file

Stored at `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>.json`. One file per Claude instance (one per OS user by default). Claude Code's config directory defaults to `~/.claude` but respects the `CLAUDE_CONFIG_DIR` environment variable.

The file is written by Claude (via the Write tool) and read by hooks. Hook reads and writes are symlink-safe and use atomic operations. Claude's Write tool writes (the task entries) are not atomic — see Known Issues #2.

## Journal Schema

```json
{
  "why":         "string (max 200 chars) — current intent, may start with [GUESS]",
  "when":        "ISO 8601 — timestamp of last write",
  "why_history": [
    {"w": "string — previous why value", "t": "ISO 8601"}
  ]
}
```

`why_history` is appended only when `why` changes value. Capped at 10 entries — oldest dropped when limit is exceeded. File must stay under 6KB.

**Schema validation**: `readJournal()` returns null for any journal missing the `why` field — this includes all pre-v0.4.0 journals. A null result triggers a fresh-start prompt, and Claude creates a new v0.4.0 journal.

## Setting Up for Development

You need Node.js 14.14+ installed (for `fs.rmSync` and `fs.mkdirSync({ recursive: true })`). No other dependencies.

```bash
git clone https://github.com/ianreboot/memento.git
cd memento

# Install hooks (standalone path — for testing without the plugin system)
bash hooks/install.sh

# Test the SessionStart hook directly
echo '{"source":"compact"}' | node hooks/memento-activate.js

# Test the UserPromptSubmit hook (Turn 1, no prior journal)
echo '{}' | node hooks/memento-tracker.js

# Inspect a journal
cat ~/.claude/.memento/<username>.json | python3 -m json.tool

# Enable debug output
echo '{"source":"startup"}' | MEMENTO_DEBUG=1 node hooks/memento-activate.js
```

## Testing Changes

Since memento is a Claude Code plugin, full end-to-end testing requires Claude Code. For unit-level testing:

1. **Hook I/O**: Pipe JSON to hook scripts and inspect stdout. See examples above.
2. **Journal utilities**: Write a small test script that calls functions from `memento-config.js` directly.
3. **Integration**: Install hooks, open Claude Code, complete some tasks, trigger compaction manually (by filling context), and verify recovery.

Run the test suite with `bash tests/run.sh`. It covers journal utilities, hook integration, write helper, and symlink safety (127 tests total).

## Contribution Guidelines

### What to contribute

- Bug fixes in hook scripts
- Improvements to the SKILL.md (better entry format, clearer instructions, edge case handling)
- Windows support (`hooks/install.ps1`)
- Test suite
- Performance improvements (hook latency, journal size)
- Documentation improvements

### What to keep in mind

**Silent failure is mandatory.** Hooks must never crash Claude Code or block session start. Wrap all I/O in try/catch and exit cleanly on any error.

**Security — use the provided utilities.** Any new write to the journal file must go through `writeJournal()` from `memento-config.js`. Writing directly with `fs.writeFileSync()` on a predictable path reopens the symlink-clobber attack surface that `writeJournal()` defends against.

**Respect `CLAUDE_CONFIG_DIR`.** Never hardcode `~/.claude`. Always use `process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')`.

**Keep hooks fast.** The UserPromptSubmit hook runs on every user message. Any I/O that blocks synchronously adds perceived latency. Current p99 is under 10ms. Keep it there.

**No user-visible output from hooks.** Everything goes through `hookSpecificOutput.additionalContext` (UserPromptSubmit) or stdout (SessionStart). Never `console.log()` in hook scripts.

**SKILL.md is the single source of truth for behavior.** If you want to change what Claude journals or how, edit SKILL.md. Do not duplicate behavior in hook scripts.

**README must stay accurate.** If your change affects user-visible behavior, update README.md. Keep it jargon-light — it is the public face of the project.

### Pull request checklist

- [ ] Hooks silent-fail on all filesystem errors
- [ ] Any new journal writes use `writeJournal()` from `memento-config.js`
- [ ] Hook scripts do not produce user-visible output
- [ ] `CLAUDE_CONFIG_DIR` is respected (no hardcoded `~/.claude`)
- [ ] README.md updated if behavior changes
- [ ] SKILL.md updated if Claude's journaling behavior changes
- [ ] Tested end-to-end in Claude Code (at least manually)

## Project Philosophy

Memento solves one problem: surviving context compaction with correct intent. It does not try to be a general-purpose memory system. Permanent project knowledge belongs in `CLAUDE.md`. Temporal session notes belong in `MEMORY.md`. Memento owns only the intent-level state — the why — that compaction destroys and that neither of those layers captures automatically.

Keep it simple. Keep it fast. Keep it invisible.

## License

MIT. See [LICENSE](LICENSE).
