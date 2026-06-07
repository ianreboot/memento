# Known Issues

Issues that cannot be fully resolved in code due to architectural constraints or platform limitations.

## 1. ~~Concurrent Claude instances (last-writer-wins)~~ — **Fixed in v0.6.0**

Per-project namespacing isolates each project's journal, ctx_bridge, and sidecar files by an 8-char hash of the git root path. Two Claude Code sessions running simultaneously in different project directories now have fully isolated state — no configuration required.

Within the same project directory, the atomic rename still protects against corruption but two sessions writing simultaneously remains last-writer-wins (the `MEMENTO_INSTANCE_TAG` workaround no longer applies since both sessions share the same project hash; use different user accounts or containers for full isolation within a single project).

## 2. ~~Claude's Write tool bypasses atomic write protections~~ — **Fixed in v0.5.6**

Journal writes now route through `memento-write-why.js`, which uses the same atomic
`temp+rename` write as `writeJournal()`. Crash during a journal write no longer results
in a partially-written or corrupt file.

## 3. Windows symlink protection gap

On Windows, `O_NOFOLLOW` is not available (falls back to 0). The TOCTOU window between lstat() and open() in readJournal() could allow a symlink replacement attack. A local attacker could inject content into Claude's context.

**Mitigation**: Content is bounded by the 6KB size cap and the JSON schema validation. Impact is limited to context injection, not file clobbering (writeJournal has additional ownership checks).

## 4. No rollback on partial install failure

`hooks/install.sh` uses `set -euo pipefail`. If any step fails mid-install, the system is left in a partially-installed state (some files present, settings.json possibly not updated).

**Recovery**: Run `bash hooks/install.sh --uninstall` to clean up, then re-run the installer.

## 5. Legacy orphaned journal files

If you used memento before v0.1.0, you may have journal files from an earlier naming scheme (named after git repos rather than your OS username). These are inert — hooks will not read or write them — but they sit in `~/.claude/.memento/` taking up space.

**Cleanup**: Review files in `~/.claude/.memento/` and delete any that don't match the `{instanceTag}-{projectHash}.json` pattern.

**v0.6.0 upgrade**: Files written by v0.5.x (named `{instanceTag}.json` and `ctx_bridge.json`) remain in `~/.claude/.memento/` as inert files after upgrading. They are safe to delete. New files follow the `{instanceTag}-{projectHash}.json` pattern.

## 8. v0.6.0 upgrade: journal history is not migrated

After upgrading from v0.5.x to v0.6.0, the first session in each project produces a "No prior journal" Turn 1 prompt — identical to first-install behavior. Existing intent history (`why`, `why_history`) from v0.5.x journal files is not migrated to the new namespaced paths.

**Impact**: One session of missing prior context per project after upgrade. Not a recurring issue.

**Delete when**: 2026-07-01 (one month after v0.6.0 release, users have had time to upgrade).

## 6. Context bridge coverage across fast-growing sessions

The tracker emits a `[BRIDGE]` directive when context reaches 74% at the start of a user turn. For sessions where context grows quickly within a single response turn — reading many large files or processing large API responses in sequence — the tracker's turn-boundary check may not fire before auto-compaction triggers.

**Coverage**: The PreCompact hook handles this automatically. When compaction fires, the hook uses AI extraction from the session transcript to write the bridge directly, independent of the tracker. The bridge will be present at recovery even when the tracker directive was never reached.

## 7. Session exit bridge contains intent only (not specific files or error)

When a session ends cleanly (user exits Claude Code) without having compacted, the SessionEnd hook writes a minimal bridge containing only `journal.why` as the `next` field. Files being edited and current error state are not captured in this path.

**Coverage**: For sessions that exit cleanly at low context (below 74%), this bridge still provides correct intent direction for the next session. Sessions that hit 74% context before exiting will have a richer bridge from the tracker or PreCompact hook. The SessionEnd bridge is the last-resort fallback and is not written if a richer bridge already exists.

## 9. 1M-context sessions: the runway estimate can read low until usage passes 200k

Claude Code does not expose the active context window size to hooks. The hook payload, the transcript `model` field, and the environment all omit it; the `[1m]` model-id suffix that marks a 1M session is a CLI-level flag that is stripped before the model id reaches the API and the transcript. (This is a platform limitation, not specific to memento: Claude Code's own context-window lookup has the same gap, because its `has1mContext()` check also relies on the `[1m]` suffix that API responses do not carry.)

Memento therefore infers the window from usage: a session is treated as 200k until observed usage passes the 200k mark (impossible on a true 200k window), at which point it latches 1M for the rest of the conversation.

**Consequence**: on a 1M-context session, before usage crosses ~200k the runway is measured against the 200k compaction point, so the `[BRIDGE]` checkpoint can fire early with a low "tokens until compaction" figure even though real headroom is large.

**This does not affect recovery correctness.** The bridge is still written and consumed normally; only the runway *number* is early. The `[BRIDGE]` directive is worded as a routine checkpoint and explicitly tells Claude not to change its behavior based on the figure.

**Fix**: set `MEMENTO_CONTEXT_WINDOW_TOKENS=1000000` to pin the window from the first turn and skip detection. Set it as an environment variable, or in the `env` block of `settings.json`:

```json
{ "env": { "MEMENTO_CONTEXT_WINDOW_TOKENS": "1000000" } }
```

Reliable hook-side auto-detection is not currently possible. This will be revisited if Claude Code adds the context window size to the hook payload.
