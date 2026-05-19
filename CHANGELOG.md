# Changelog

## v0.2.4 — 2026-05-19

- **C1 — closed-mission injection suppression**: `formatJournalForInjection` now returns a minimal one-liner for closed missions in brief mode (`[MEMENTO] No active mission | proj:... | path:...`) and a 1-2 line header with summary in full (recovery) mode. Previous behavior injected full done/plan/wip for closed missions — irrelevant noise on 100% of post-close sessions.
- **C2 — stale-open-mission reminder cooldown**: `memento-tracker.js` stale-reminder branch now uses a 10-minute cooldown sidecar (`.stale-reminded`). First stale turn fires the escalated reminder; subsequent turns within the window suppress to a normal brief reminder. Cooldown resets automatically when Claude writes a new entry. Mirrors the closed-mission sidecar mechanism from S4.
- **C3 — post-install verification**: `install.sh` now runs a path-check node script after wiring, confirming that `settings.json` hook commands reference `$HOOKS_DIR`. Reports `ok`/`FAIL` per hook and suggests `--force` if wiring looks wrong. Warn-only; does not fail the install.
- **C4 — SKILL.md behavioral rules**: Added trigger #7 (no-mission work: bare wip write before significant work when `mission_closed` is set) and an infrastructure-change callout (env vars, cloud config, DB records, deployed secrets must always be journaled, regardless of mission state).

## v0.2.3 — 2026-05-14

- **S1 — recovery anchor write trigger**: Added step 0 to Recovery After Compaction section: when `mission_closed` is null, `done` is empty, and `wip` is null, Claude writes a session start checkpoint entry immediately. Protects open missions from losing all context on the next compaction.
- **S2 — subject mandate at mission-open**: Rewrote trigger #1 and subject field section in SKILL.md to make `subject` a mandatory write at mission-open time (not optional reference material). Added retroactive repair instruction for recovering Claude with existing mission and unset `subject`.
- **S3 — newline sanitization**: Added `sanitizeLine()` helper in `memento-config.js`; applied to all string fields in `applyFieldLimits()` (`mission`, `subject`, `act`, `result`, `ctx`, `plan` items, `wip`, `summary`). Prevents embedded `\n` from breaking the line-per-field injection format. Whitespace-only values coerced to `null` on `wip` and `summary`.
- **S4 — closed-mission reminder cooldown**: Replaced every-turn reminder for closed missions with a sidecar file approach (`<instance>.reminded`). Reminder fires once per mission closure (first turn after close), then suppresses. Self-healing: corrupted sidecar re-fires; new mission closure (different timestamp) invalidates automatically.

## v0.2.2 — 2026-05-13

- **subject field**: New optional journal field (`subject`, max 80 chars) lets Claude separate where it is running (`project`, git-derived) from what the work is actually about. Cross-project suppression now uses `subject` when set, preventing mission details from injecting into unrelated project sessions. The `Previous work` label also uses `subject` so suppressed entries are correctly attributed.
- **wip position in full injection**: Post-compaction recovery injection now shows `WIP:` immediately after the mission header, before done entries. A recovering Claude sees active work before task history.

## v0.1.0 — 2026-05-05

Initial public release.

- Hook-based architecture: SessionStart (activate) + UserPromptSubmit (tracker)
- Per-instance journal design: one file per Claude docker/user, not per project
- Rolling window: 8 completed entries, 5 upcoming, 300-char summary
- Stale collapse: entries older than 7 days folded into summary at session start
- Mission lifecycle: auto-close on /clear, in-progress tracking, state/blocked/waiting
- `MEMENTO_DEBUG=1` shadow journal for post-session forensics
- Atomic writes, symlink-safe I/O, 0600 permissions, 6KB size cap
- Test suite: 45 tests across journal utilities, hook integration, and symlink safety
- Plugin install: `/plugin marketplace add ianreboot/memento` then `/plugin install memento@ianreboot-memento`
- Standalone install: `curl -fsSL .../install.sh | bash`
