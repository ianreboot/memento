# Contributing to memento

Memento is open source and welcomes contributions. This document explains how the project works, how to set up a development environment, and what to keep in mind when submitting changes.

## How Memento Works

Memento has three components that work together:

### 1. The SKILL.md (`skills/memento/SKILL.md`)

This is loaded into Claude's context whenever the skill triggers. It instructs Claude on:
- When and how to write journal entries
- The fidelity rule (only record what was stated or observed)
- Entry format and compression
- Mission lifecycle
- Recovery behavior after compaction

**Claude is the only journal writer.** The SKILL.md is what makes Claude write. If you want to change what gets journaled or how, edit SKILL.md.

### 2. The hooks (`hooks/`)

Two hooks run automatically on every Claude Code session:

**`memento-activate.js`** (SessionStart):
- Reads the journal for the current project
- Prunes stale entries if needed
- Formats the journal as plain text
- Writes to stdout — Claude Code injects this as hidden system context
- Full injection on `source: "compact"` or `"resume"`. Brief summary on `source: "startup"`.

**`memento-tracker.js`** (UserPromptSubmit):
- Reads the user's prompt from stdin
- Detects `/clear` and project-shift language → marks mission closed
- Emits a per-turn reminder via `hookSpecificOutput.additionalContext` (mission name, state, last/wip task)
- This reminder is invisible to the user

**`memento-config.js`** (shared utilities):
- Instance tag: `getInstanceTag()` → OS username → "default" (journal file path; override with `MEMENTO_INSTANCE_TAG`)
- Project tag: `getProjectTag()` → git root basename → cwd basename → "default" (informational only; common names blocklisted)
- `readJournal()` — symlink-safe, size-capped JSON read
- `writeJournal()` — atomic temp+rename, symlink-safe, 0600 permissions
- `pruneJournal()` — rolling window, staleness collapse
- `formatJournalForInjection()` — converts JSON to plain-text injection format

### Hook definition file

One file defines the hooks for the plugin install path:

- **`.claude-plugin/plugin.json`** — used by `claude plugin install` (nested `hooks: { EventName: [...] }` object)

The standalone installer (`hooks/install.sh`) does not use this file — it patches `~/.claude/settings.json` directly with inline Node.js.

### 3. The journal file

Stored at `$CLAUDE_CONFIG_DIR/.memento/<instance-tag>.json`. One file per Claude instance (one per OS user by default). Claude Code's config directory defaults to `~/.claude` but respects the `CLAUDE_CONFIG_DIR` environment variable.

The file is written by Claude (via the Write tool) and read by hooks. Both reads and writes are symlink-safe and use atomic operations.

## Journal Schema

```json
{
  "mission":        "string",
  "mission_opened": "ISO 8601",
  "mission_closed": "ISO 8601 or null",
  "project":        "string",
  "summary":        "string or null (max 300 chars)",
  "state":          "\"active\" | \"blocked\" | \"waiting\"",
  "state_reason":   "string or null (max 120 chars)",
  "in_progress":    "{ task, started, progress } or null",
  "completed": [
    {
      "task":   "string (max 80 chars)",
      "result": "string (max 120 chars)",
      "ctx":    "string (max 120 chars)",
      "ts":     "ISO 8601"
    }
  ],
  "upcoming": ["string"]
}
```

Rolling window: max 8 completed entries. When entry 9 is added, the oldest is folded into `summary`. Max 5 upcoming entries. File must stay under 6KB.

## Setting Up for Development

You need Node.js 14.14+ installed (for `fs.rmSync` and `fs.mkdirSync({ recursive: true })`). No other dependencies.

```bash
git clone https://github.com/ianreboot/memento.git
cd memento

# Install hooks (standalone path — for testing without the plugin system)
bash hooks/install.sh

# Test the SessionStart hook directly
echo '{"source":"compact"}' | node hooks/memento-activate.js

# Test the UserPromptSubmit hook
echo '{"prompt":"/clear"}' | node hooks/memento-tracker.js

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

Run the test suite with `bash tests/run.sh`. It covers journal utilities, hook integration, and symlink safety (45 tests total).

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

Memento solves one problem: surviving context compaction. It does not try to be a general-purpose memory system. Permanent project knowledge belongs in `CLAUDE.md`. Temporal session notes belong in `MEMORY.md`. Memento owns only the task-level, mission-scoped state that lives between those layers.

Keep it simple. Keep it fast. Keep it honest (fidelity rule). Keep it invisible.

## License

MIT. See [LICENSE](LICENSE).
