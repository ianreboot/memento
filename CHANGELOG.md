# Changelog

## v0.2.3 — 2026-05-14

- **S1 — recovery anchor write trigger**: Added step 0 to Recovery After Compaction section: when `mission_closed` is null, `done` is empty, and `wip` is null, Claude writes a session start checkpoint entry immediately. Protects open missions from losing all context on the next compaction.
- **S2 — subject mandate at mission-open**: Rewrote trigger #1 and subject field section in SKILL.md to make `subject` a mandatory write at mission-open time (not optional reference material). Added retroactive repair instruction for recovering Claude with existing mission and unset `subject`.
- **S3 — newline sanitization**: Added `sanitizeLine()` helper in `memento-config.js`; applied to all string fields in `applyFieldLimits()` (`mission`, `subject`, `act`, `result`, `ctx`, `plan` items, `wip`, `summary`). Prevents embedded `\n` from breaking the line-per-field injection format. Whitespace-only values coerced to `null` on `wip` and `summary`.
- **S4 — closed-mission reminder cooldown**: Replaced every-turn reminder for closed missions with a sidecar file approach (`<instance>.reminded`). Reminder fires once per mission closure (first turn after close), then suppresses. Self-healing: corrupted sidecar re-fires; new mission closure (different timestamp) invalidates automatically.

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
