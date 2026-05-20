# Changelog

## v0.3.0 — 2026-05-20

- **A — No-mission nudge at recovery**: `memento-activate.js` now appends a wip-write prompt when source is `compact` or `resume` and the journal has no active mission (`mission_closed` is set). Fires once per recovery session by definition (SessionStart runs once). Never fires on fresh startup or when a mission is open. Addresses the dominant observed failure: Claude stops journaling entirely between missions.
- **B — Cross-project stale mission warning**: When cross-project suppression fires after a project switch without `/clear`, the injection header now includes `(mission was: old-project)`. The old project is captured in `memento-activate.js` before the project field is overwritten and passed to the formatter as `{ previousProject }`. Integrated into the existing cross-project suppression path — not a post-injection append.
- **C — Bare wip schema relaxation**: `readJournal` now accepts `mission: null` (journals written via trigger #7 with no open mission). `formatJournalForInjection` outputs a clean "No active mission" header instead of "Mission: null" or "Mission: [no mission set]". `memento-tracker.js` reminder gate changed from `journal.mission` to `journal.mission || journal.wip`; when mission is null and wip is set, emits `[MEMENTO: wip: "..." | no active mission]`.
- **C5 — Install verification hard-fail**: Removed `|| true` from the post-install verification script in `install.sh`. The node verification script's `process.exit(1)` now propagates as a real non-zero exit rather than being silently swallowed.
- **D — PreCompact auto-checkpoint hook**: New `hooks/memento-precompact.js` fires before context compaction. If the journal exists and `wip` is null, emits a checkpoint prompt so Claude can write current task state before the compaction window closes. Silent when wip is already set (already checkpointed) or no journal exists. Registered in `plugin.json` (timeout: 5000) and `install.sh` (all 4 locations: HOOK_FILES array, uninstall loop, --force strip loop, hasHook/wiring block). Output format: raw text to stdout, same as SessionStart.
- **S1 — Active debugging as mandatory wip trigger**: Added "Active debugging: when you have a working hypothesis, have ruled out causes, or are mid-investigation — the reasoning is entirely in-context and compaction destroys it completely" to the WIP Tracking bullet list in `SKILL.md`.
- **D1 — README value proposition reframe**: Replaced abstract opening paragraph with two concrete differentiators: (1) mid-task crash recovery — `wip` captures where work was before any compaction summary exists; (2) multi-session institutional memory — `done[]` preserves decision history across many compaction events where native summaries reset each time. Added when-to-use qualifier: native compaction summary is sufficient for short single-window sessions; memento's value compounds across multiple compaction events.
- **Tests**: 84 passing (up from 69) — 15 new tests covering A (3), B (3), C (5 in journal utils + 1 in hooks), D (4).

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
