# Changelog

## v0.4.2 — 2026-05-22

Installer bug fixes.

- **Fix same-file copy error in `hooks/install.sh`**: When the top-level `install.sh` delegates to `hooks/install.sh`, `SCRIPT_DIR` resolves to the same path as `HOOKS_DIR` (both `~/.claude/hooks/`). The `cp` command fails with "are the same file". Fixed by adding a `SCRIPT_DIR != HOOKS_DIR` guard — when paths match, falls through to curl download. Affected `--force` upgrades and fresh `curl | bash` installs.
- **Add missing `memento-precompact.js` to top-level installer**: The top-level `install.sh` download list had 6 files but `hooks/install.sh` expected 7. The PreCompact hook was never downloaded by the top-level script, causing the delegated installer to fall through to curl for that file (or skip it if offline).

## v0.4.1 — 2026-05-22

Why-quality guidance across all hook prompts and session-close outcome capture in SKILL.md.

- **"(purpose, not action)" hint in all hook prompts**: Every `Write why+when` instruction across all 10 prompt variants (tracker T2+ x3, activate T1/recovery x5, precompact x2) now includes `(purpose, not action)`. Addresses observed drift where the `why` field captures action descriptions ("writing calibration doc") rather than intent ("benchmarking planning quality to identify brain/skill fixes"). The hint fires at the moment of writing with near-zero cognitive overhead (~3 tokens per prompt).
- **Session-close outcome instruction**: SKILL.md now includes: if the session is ending, update why with the outcome ("Done: X. Next: Y." or "Stopped mid-X, resume at Y."). Addresses the restart recovery gap where a new session cannot determine whether the previous session succeeded, failed, or was abandoned. Best-effort behavioral instruction — works for graceful session endings, no mechanism for abrupt terminations.
- **No schema changes.** The why+when+why_history schema is unchanged.
- **Version bumps**: plugin.json and marketplace.json updated to 0.4.1.

## v0.4.0 — 2026-05-21

Complete schema replacement. The mission/done/plan/wip structure is replaced by a minimal intent journal: `{ why, when, why_history }`.

**Core change — mandatory writes:** Every turn emits a MANDATORY WRITE prompt. Claude writes current intent before every response. [GUESS] is always valid — eliminates the ~0% voluntary-write compliance observed across 25+ real sessions with v0.3.x.

**New schema:**
- `why` (max 200 chars): current intent — what you are trying to accomplish and why
- `when`: ISO timestamp of last write
- `why_history`: array of previous `why` values (capped at 10, oldest dropped) — tracks how intent evolved

**Removed:** mission lifecycle, done[] entries, plan[], wip, summary, rolling window, staleness collapse, /clear detection, project-shift detection
**Removed env vars:** `MEMENTO_MAX_ENTRIES`, `MEMENTO_STALE_DAYS`
**New in memento-config.js:** `getTurnSidecarPath()`, `sanitizeLine()` (now exported), `MAX_WHY_CHARS`, `MAX_WHY_HISTORY`
**Turn sidecar:** `.turn` file alongside journal tracks turn number for T1 (full prompt) vs T2+ (compressed prompt) discrimination
**PreCompact hook:** now always fires (previously conditional on `wip=null`)
**Migration:** pre-v0.4.0 journals (no `why` field) are treated as non-existent. Claude will be prompted to start fresh.
**Tests:** 58 passing (v0.3.x-specific tests removed; new tests cover v0.4.0 schema validation, sidecar path, history capping)

## v0.3.1 — 2026-05-20

- **Signal 2 — per-turn no-mission reminder**: `memento-tracker.js` now emits a per-turn `[MEMENTO: no active mission | no wip — write bare wip if doing task work (trigger #7)]` reminder when no active mission is open and `wip` is null. No sidecar suppression. Fires every turn until Claude writes a wip entry. Covers all three no-mission states: `mission_closed` set (after Signal 1 fires), mission never set, and bare null-mission journals from trigger #7.
- **Path D — wip visibility after Signal 1**: Once Claude writes a `wip` in a no-mission session, the tracker emits `[MEMENTO: no active mission | wip: "..." — update if changed]` each turn. Previously, the sidecar suppressed all reminders after Signal 1, so wip was captured on disk but never surfaced per-turn again. Path D closes this gap.
- **Architectural change**: The tracker's two-path routing (active mission / closed-mission-sidecar) is replaced by four-path routing (A: active mission, B: Signal 1 one-time close reminder, C: Signal 2 per-turn no-mission nudge, D: per-turn wip visibility). The outer gate `if (journal.mission || journal.wip)` is removed — all journal states are now handled, including journals where both are null.
- **Root cause**: `UserPromptSubmit` fires only when the user submits a prompt. Every hook execution is active work by definition. The sidecar suppression that blocked Paths C and D was solving a problem that does not exist — the injection is invisible to the user and there is no idle state to protect against.
- **Tests**: 87 passing (up from 84) — 3 new tests covering Path C (never-set mission), Path C (sidecar-fired + wip null), Path D (sidecar-fired + wip set). Updated existing sidecar-suppression test to reflect correct new behavior.

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
