# Known Issues

Issues that cannot be fully resolved in code due to architectural constraints or platform limitations.

## 1. Concurrent Claude instances (last-writer-wins)

When two Claude Code windows work on the same project simultaneously, journal writes use last-writer-wins. The atomic rename protects against corruption but not against lost entries. The instance whose Write tool call lands second overwrites the first's entry.

**Impact**: Occasional lost task entries during multi-session use.

**Workaround**: Set `MEMENTO_INSTANCE_TAG` to different values per instance so each gets its own journal file.

## 2. Claude's Write tool bypasses atomic write protections

The primary journal write path (Claude using the Write tool as instructed by SKILL.md) does not use the atomic temp+rename write in `writeJournal()`. If Claude Code crashes mid-write, the journal file may be partially written and unreadable. The hooks detect this (readJournal returns null on invalid JSON) and start fresh, losing prior state.

**Mitigation**: The activate hook's stale-collapse write IS atomic. The next session start will attempt recovery.

## 3. Windows symlink protection gap

On Windows, `O_NOFOLLOW` is not available (falls back to 0). The TOCTOU window between lstat() and open() in readJournal() could allow a symlink replacement attack. A local attacker could inject content into Claude's context.

**Mitigation**: Content is bounded by the 6KB size cap and the JSON schema validation. Impact is limited to context injection, not file clobbering (writeJournal has additional ownership checks).

## 4. No rollback on partial install failure

`hooks/install.sh` uses `set -euo pipefail`. If any step fails mid-install, the system is left in a partially-installed state (some files present, settings.json possibly not updated).

**Recovery**: Run `bash hooks/install.sh --uninstall` to clean up, then re-run the installer.

## 5. Legacy orphaned journal files

If you used memento before v0.1.0, you may have journal files from an earlier naming scheme (named after git repos rather than your OS username). These are inert — hooks will not read or write them — but they sit in `~/.claude/.memento/` taking up space.

**Cleanup**: Review files in `~/.claude/.memento/` and delete any that don't match your OS username.
