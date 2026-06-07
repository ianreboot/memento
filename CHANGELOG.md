# Changelog

## v0.8.4 — 2026-06-07

Reframes the `[BRIDGE]` checkpoint as a routine safety net rather than an alarm, so a capable model keeps working at full depth instead of reacting to a runway figure that can read low on large-context sessions.

- **Changed**: the `[BRIDGE]` directive now leads as a routine checkpoint and states that once the bridge is written the session is safe to continue at full depth, with no rushing, compressing, hedging, or wrapping up early. It also notes that the "tokens until compaction" figure can read low on a 1M-context window and should never gate behavior.
- **Changed**: the skill carries the same "safety net, not an alarm" semantics and tells Claude to reason from actual context usage rather than the runway estimate.
- **New**: the skill instructs a recovering session to verify a bridge's `next` state claims (done, complete, pushed, fixed) against ground truth before acting on them. The `next` field is the prior session's intent at write time and can record about-to-do work as already done.
- **Docs**: documented the 1M-context runway behavior and the `MEMENTO_CONTEXT_WINDOW_TOKENS` pin in KNOWN_ISSUES, including the platform limitation that prevents reliable hook-side window detection.

## v0.8.3 — 2026-06-05

Closes a silent cross-restart recovery failure that survived the v0.8.1/v0.8.2 key-scoping fixes. Those releases made the context bridge project-scoped and gave it a stable, cwd-independent key — but the bridge's *source* still depended on a conversation hash. `write-why` is a plain CLI call with no hook stdin, so it resolves the journal (conversation-scoped) through the per-instance anchor, while the SessionEnd/PreCompact hooks resolve it through the authoritative `transcript_path`. When those two conversation hashes diverge — a stale anchor, an upgrade boundary, a sibling session — `write-why` files the `why` under hash A while the bridge writer reads hash B, finds nothing, and writes no bridge. The next session then starts with no `[CTX BRIDGE]` even though clear intent was recorded.

- **Fixed**: `write-why` now also maintains a **project-scoped `last_why` mirror** (`~/.claude/.memento/last_why-{projectHash}.json` = `{why, at}`), keyed by the same stable slug-derived `projectHash` the bridge already uses. SessionEnd and PreCompact fall back to this mirror (`readLastWhy`) when the live-transcript journal has no `why`. Because writer and reader now only need to agree on the *project* — not the conversation — a divergent conversation hash can no longer break the handoff. The mirror is read with a recency bound and **fails closed** (a non-positive or invalid max-age rejects everything, so stale intent is never resurrected), and when the bridge is recovered from the mirror it carries the mirror's real timestamp so the fresh-start recency gate reflects the intent's true age.
- **Why project-scoped, not freshest-journal**: a "scan all journals, take the most recent `why`" fallback was rejected because it cannot tell which project a conversation journal belongs to and would leak one project's intent into another's bridge. The project-scoped mirror is contamination-free by construction. Residual limitation, documented not solved: two concurrent same-instance sessions on *different* projects share one anchor, so `write-why` could resolve the wrong project's hash — the same shared-anchor limitation that affects all conversation resolution.
- **Hardening**: the mirror write is atomic and symlink-safe (lstat + `O_NOFOLLOW` + `O_EXCL`, 0600 permissions), mirroring the bridge writer; the read is symlink-safe and silent-failing. The journal write is never blocked by a mirror failure.
- **Tests**: added `readLastWhy`/`writeLastWhy` unit coverage (round-trip, recency-bound expiry, fail-closed on invalid age, sanitization, symlink rejection) and SessionEnd/PreCompact fallback coverage proving a bridge is produced from the mirror when the journal `why` is absent. Suite is 185 checks. Validated on a live install through both a real harness restart and a real `/compact`.

## v0.8.2 — 2026-06-05

Completes the v0.8.1 cross-session fix. v0.8.1 correctly switched the context bridge from a per-conversation key to a per-project key, but it derived "the project" from the git root of the hook's working directory. That working directory is not stable: it can differ between the SessionStart hook (the reader) and the SessionEnd/PreCompact hook (the writer), and a **nested git repository** (a sub-project checked out inside your workspace) makes `git rev-parse` resolve a different root than the workspace itself. When reader and writer resolved different roots they computed different keys and the handoff silently failed — the same "No prior journal" symptom v0.8.1 set out to fix, in a narrower set of conditions.

- **Fixed**: the project key is now derived from the **project slug in the transcript path** (`~/.claude/projects/<slug>/<uuid>.jsonl`) — the harness's own per-project identifier, which every hook receives identically on stdin and which does not depend on the working directory. A cwd change or a nested git repo can no longer split the key between reader and writer. Resolution order is now: `MEMENTO_PROJECT_HASH` override → transcript slug → `CLAUDE_PROJECT_DIR` → git root (legacy fallback) → cwd. The bridge stays project-scoped and the journal stays conversation-scoped, exactly as in v0.8.1.
- **Tests**: added regression coverage proving the project hash is identical across working directories for the same transcript, and that SessionStart surfaces a bridge whose key was computed from a different working directory than the hook runs in (the nested-repo case). Suite is 170 checks.

## v0.8.1 — 2026-06-05

Fixes a bug that silently disabled cross-session recovery. The context bridge is meant to hand recovery context from a finished conversation to the next one you start — but since v0.7.0 it was keyed by conversation, so a brand-new session looked for it under a key the previous session never wrote. A fresh start would report "No prior journal" even when the previous session had left clear intent. Resume and compaction within the same session were unaffected; only the cross-session handoff was broken.

- **Fixed**: the `ctx_bridge` is now keyed by project (git root), not by conversation, so a new session reliably recovers the bridge written by the previous one. The journal stays conversation-scoped (each conversation keeps its own `why` history); only the bridge — whose entire purpose is to cross conversations — is project-scoped. This restores the v0.6.0 behavior that v0.7.0's conversation-anchoring work regressed. `MEMENTO_PROJECT_HASH` still overrides both keys for tests and non-git contexts.
- **Tests**: added cross-session regression coverage that exercises a differing conversation hash and project hash (the prior suite set `MEMENTO_PROJECT_HASH`, which collapsed the two keys and hid the bug). Suite is 167 checks.

## v0.8.0 — 2026-06-05

Context tracking is now anchored to the live session and aware of the real context window. Two improvements work together: the tracker reads the session's current transcript instead of a cached pointer, and the bridge trigger is measured in tokens of runway rather than a fixed percentage of an assumed window.

- **New**: context tracking anchors to the session's live transcript. Every hook receives the current `transcript_path` on stdin and uses it as the authoritative source, refreshing the per-instance anchor each session. Context usage, compaction detection, and bridge recovery now always reflect the active conversation rather than a previously cached transcript.
- **Changed**: the context window is resolved per conversation instead of assuming 200,000 tokens. Once observed usage passes the 200k mark (impossible on a 200k window), memento treats the window as 1M for the rest of the conversation and latches that result so a later compaction cannot revert it. `MEMENTO_CONTEXT_WINDOW_TOKENS` still pins the window explicitly and now disables detection when set. No model list is required.
- **Changed**: the `[BRIDGE]` directive fires on tokens of runway to the compaction point, not on a percentage of the window. A fixed percentage is a different real margin on a 200k window than on a 1M one; an absolute token margin gives the same warning distance on every window size, sized above the largest plausible single-turn growth. The cache-write spike guard is retained for sudden jumps.
- **Changed**: compaction detection compares absolute context tokens between turns rather than percentages, so resolving a larger window mid-session can never be mistaken for a compaction.
- **Changed**: on a fresh session start, a `ctx_bridge` is recovered only when it was written recently (within 6 hours). Resume and compact recovery are unchanged. This keeps an unrelated earlier session's bridge from surfacing in a new one.
- **Changed**: the `ctx_bridge` annotation field is now `left` (tokens of runway remaining when written) in place of `pct`. Bridges written by an earlier version still display correctly on upgrade.
- **New**: per-conversation `.ctxwin` sidecar persists the detected window; the `.last_ctx` sidecar now stores the absolute token total used for drop detection.

## v0.7.1 — 2026-05-26

- **Fix**: ctx_bridge injection phrasing changed from `Next: "..."` to `Prior session: "..." - verify still relevant` in both `buildBridgeInjection()` functions (activate.js and tracker.js). The directive form caused prior-session context to persist as a standing instruction, overriding explicit user redirects in subsequent turns. The informational form signals provenance rather than a task queue entry.
- **New (SKILL.md)**: behavioral rule to treat `Prior session:` as cleared when the user's opening message establishes a different project or task. Do not use it to resolve ambiguous phrases in later messages.
- **New (SKILL.md)**: why-quality self-check — "if a fresh session read only your why, would it know what question this work is trying to answer?" — and anti-pattern note for turn-type descriptions ("answering a question about X").
- **Docs**: README note on cross-instance limitation — journal context does not transfer across instances; cross-instance work requires an explicit handoff file.

## v0.7.0 — 2026-05-24

**Breaking change**: journal and ctx_bridge files are now namespaced per conversation (SHA-1 of JSONL path) rather than per project (SHA-1 of git root). v0.6.x files will not be found on upgrade. Claude creates a fresh journal on first run (identical to first-install behavior).

- **Fix**: parallel-session collision on the same project. Two Claude Code windows in the same repo shared an identical `{tag}-{projectHash}.json` journal path and overwrote each other. v0.7.0 replaces projectHash with conversationHash derived from the JSONL file path — each conversation is unique, so all files are isolated automatically.
- **New**: `resolveConversation(claudeDir, instanceTag)` — single resolution function called by all hooks. Reads the session anchor (fast path) or scans for the latest JSONL (T1/startup race). Returns `{ conversationHash, jsonlPath }`.
- **New**: `getConversationHash(jsonlPath)` — 8-char SHA-1 of the JSONL path.
- **New**: session anchor file (`{tag}.anchor`) — written by SessionStart, read by all subsequent hooks in the same session. Eliminates repeated JSONL scans on T2+.
- **Changed**: turn counter and last-ctx sidecar moved to fixed per-instance paths (no hash):
  - `{tag}.turn` (was `{tag}-{projectHash}.turn`)
  - `{tag}.last_ctx` (was `{tag}-{projectHash}.last_ctx`)
- **Fix**: `memento-write-why.js` updated to use `resolveConversation()`. Previously used `getProjectHash()` — the v0.6.0 pattern — causing Claude's journal writes to land at the project-hash path while hooks read from the conversation-hash path. Writes now go to the correct journal.
- **File format changes**:
  - Journal: `~/.claude/.memento/{tag}-{conversationHash}.json` (was `{tag}-{projectHash}.json`)
  - ctx_bridge: `~/.claude/.memento/ctx_bridge-{conversationHash}.json` (was `ctx_bridge-{projectHash}.json`)
  - Turn sidecar: `~/.claude/.memento/{tag}.turn` (was `{tag}-{projectHash}.turn`)
  - Last-ctx sidecar: `~/.claude/.memento/{tag}.last_ctx` (was `{tag}-{projectHash}.last_ctx`)
  - Session anchor (new): `~/.claude/.memento/{tag}.anchor`
- **Fallback**: when no JSONL is found (rare startup race), `getProjectHash()` (SHA-1 of git root) is used as the effective hash — same behavior as v0.6.0. Once a JSONL is found, the anchor is written and all hooks converge on the same conversationHash.
- **Test isolation**: `MEMENTO_PROJECT_HASH` env var still bypasses JSONL scan and is returned directly as the conversationHash. All 148 tests pass unchanged.
- **CLAUDE.md**: Journal Format section updated to document conversation-hash paths, session anchor, and fixed sidecar paths.
- **README**: Privacy, Context Bridge, Configuration, and Upgrade sections updated.

## v0.6.0 — 2026-05-24

**Breaking change**: journal and ctx_bridge files are now namespaced per project. Files from v0.5.x will not be found on upgrade. Claude creates a fresh journal on first run in each project (identical to first-install behavior). Existing intent history is not migrated. See the Upgrade section in README for details.

- **Fix**: per-project file namespacing eliminates parallel session state collisions. Developers who run two Claude Code windows in different project directories now get fully isolated journal, bridge, and sidecar files — no configuration required. Reported by community audit of multi-project usage patterns.
- **New**: `getProjectHash()` — derives an 8-char SHA-1 of the git root path (falls back to `process.cwd()` outside git repos). Override with `MEMENTO_PROJECT_HASH` env var for testing or non-git contexts.
- **File format change**:
  - Journal: `~/.claude/.memento/{instanceTag}-{projectHash}.json`
    (was: `~/.claude/.memento/{instanceTag}.json`)
  - ctx_bridge: `~/.claude/.memento/ctx_bridge-{projectHash}.json`
    (was: `~/.claude/.memento/ctx_bridge.json`)
  - Turn sidecar, last-ctx sidecar, and debug journal are derived from the journal path and update automatically.
- **Docs**: Added architecture explanation for why the PreCompact hook uses a `claude -p` inference call. This is load-bearing — the hook system is one-way and there is no other mechanism for AI extraction at compaction time.
- **Tests**: all path fixtures updated; `MEMENTO_PROJECT_HASH` env override added for deterministic test paths; 7 new tests added (getProjectHash, parallel-session isolation, path format assertions).
- **Plugin manifests**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` bumped to 0.6.0.

## v0.5.6 — 2026-05-23

Bridge consumption is now source-agnostic: `memento-activate.js` injects and deletes
`ctx_bridge.json` whenever the file is present, regardless of the session `source` field.
Previously only consumed on `source=startup`, leaving bridges written by the PreCompact
hook unconsumed when sessions returned via `source=compact`.

- **Fix**: `memento-activate.js` — remove `source=startup` gate on bridge consumption.
  Bridge file existence is the signal; source field is not.
- **Why this matters**: Manual `/compact` at low context (below 74%) and auto-compaction
  via the PreCompact path both set `source=compact` on return. The bridge was present but
  never injected. Removing the gate closes this gap for all compaction paths.
- **New**: `memento-write-why.js` — write helper script. Claude runs `node /path/to/memento-write-why.js '<why>'`
  instead of writing JSON via the Write tool. Eliminates the Read-before-Write friction (Write tool requires
  a prior Read of the same file), reducing each journal write from 3 tool calls to 1 Bash call.
  The script reads the existing journal, manages `why_history` (append-on-change, cap at 10), and writes
  atomically via `writeJournal()` — fixing KNOWN_ISSUES.md #2 (Write tool path bypassed atomic protections).
- **SKILL.md updated** to instruct `node <cmd> '<your why>'`. `why_history` management rules removed
  from SKILL.md (script handles them). Fallback to Write tool documented for missing-script edge case.
- **No journal schema changes.** Same `{why, when, why_history}` format.
- **Tests**: 127 passing (8 new tests for write helper, updated prompt assertions).

## v0.5.5 — 2026-05-23

SessionEnd hook rewritten to write the bridge directly without spawning a subprocess.

- **Fix**: `memento-sessionend.js` — replace `claude -p` subprocess with direct Node.js
  file I/O using `journal.why` as the bridge `next` value.
- **Why**: On session exit, spawned subprocesses are frequently killed before they can
  complete. The OS terminates child processes when the parent exits; the 15s hook timeout
  was not reliably honored. Result: bridge was not written on clean exit roughly half the
  time. Direct file write completes in milliseconds and is 100% reliable.
- **Trade-off**: Bridge written by SessionEnd contains intent (`next = journal.why`) but
  not specific files or current error. Richer bridges from the tracker (74%+ threshold)
  and PreCompact hook always take priority — the SessionEnd bridge is a fallback for
  sessions that end cleanly without ever approaching the compaction threshold.
- **No schema changes.** Bridge format unchanged; `files` is always `[]`.

## v0.5.4 — 2026-05-23

SessionEnd hook added. Closes the recovery gap for sessions that end without compacting.

- **New hook**: `memento-sessionend.js` registered on `SessionEnd` event (fires on clean
  exit, crash, and interrupt). Writes `ctx_bridge.json` from the session transcript via
  `claude -p` AI extraction (same mechanism as PreCompact). Falls back to `journal.why`
  if AI extraction fails or times out.
- **Bridge priority preserved**: SessionEnd hook checks for existing bridge before writing.
  A richer tracker bridge (74%+) or PreCompact bridge is never overwritten.
- **plugin.json**: `SessionEnd` hook registered with 15s timeout (shorter than PreCompact's
  35s to minimize visible exit delay).
- **install.sh**: `memento-sessionend.js` added to `HOOK_FILES` array and all four
  installer sections (download, uninstall, --force strip, wiring block).

## v0.5.3 — 2026-05-23

PreCompact hook upgraded to AI-quality bridge extraction.

- **Upgrade**: `memento-precompact.js` — replaces the simple `[BRIDGE]` directive
  (requiring Claude to write the bridge) with `claude -p` AI extraction from the session
  transcript tail. Hook writes `ctx_bridge.json` directly — no Claude action needed.
- **Why**: PreCompact is the last chance before compaction. If Claude is mid-task and
  misses the `[BRIDGE]` directive, the hook catches it with its own AI extraction.
- **Fake binary support**: `MEMENTO_CLAUDE_BIN` env var overrides the `claude` binary —
  enables deterministic testing without a running Claude Code instance.
- **Transcript fallback**: `transcript_path` from hook stdin JSON used when available;
  falls back to `findLatestJsonl()` when empty (covers GH issue #13668).
- **memento-config.js**: `getCtxBridgePath`, `writeCtxBridge`, `readCtxBridge`,
  `deleteCtxBridge`, `findLatestJsonl`, `readLastUsage`, `CONTEXT_WINDOW` added.
- Version string bumped to v0.5.3 in config.

## v0.5.2 — 2026-05-23

Compaction drop detection hardened for first-session-after-restart case.

- **Fix**: `memento-tracker.js` — when `last_ctx` sidecar is absent (first turn of a
  fresh session), fall back to bridge file presence + current pct below trigger threshold
  as compaction signal. Covers the case where a prior session compacted, SessionEnd wrote
  a bridge, and the tracker has no `last_ctx` to compute a drop from.
- Threshold: `bridge present + current pct < BRIDGE_TRIGGER_PCT (74%)` → infer compaction.

## v0.5.1 — 2026-05-23

Context drop detection added to tracker. PreCompact always emits `[BRIDGE]`.

- **New**: `memento-tracker.js` — compaction detection via ctx% drop. Reads `last_ctx`
  sidecar from previous turn; if drop ≥ 20pp, reads and injects `ctx_bridge.json` into
  the current turn's `additionalContext`, then deletes the bridge file. Covers inline
  auto-compaction (where `SessionStart` does not fire).
- **New**: `memento-precompact.js` — now unconditionally emits `[BRIDGE]` write directive,
  even when the tracker bridge was not written (e.g. manual `/compact` below 74%).
- **New**: `memento-config.js` — `getLastCtxPath`, `readLastCtxPct`, `writeLastCtxPct`,
  `CTX_DROP_THRESHOLD=20`.
- **Changed**: `memento-activate.js` — bridge injection moved to tracker; activate no
  longer reads or deletes `ctx_bridge.json` (this is reversed in v0.5.6).

## v0.5.0 — 2026-05-23

Context bridge: structured pre-compaction snapshot captures exact resumption state.

Intent alone (`why`) tells Claude what it was doing — but not which file it was editing,
what line the error was on, or what the exact next step is. v0.5.0 adds a structured
recovery snapshot written before compaction and injected at recovery.

- **New**: `ctx_bridge.json` sidecar at `~/.claude/.memento/ctx_bridge.json`. Schema:
  `{ files, next, err, pct, at }`.
- **New**: `[BRIDGE]` directive in `memento-tracker.js` at ≥74% context (or cache-write
  spike past 3000 tokens at ≥60%) — instructs Claude to write the bridge file.
- **New**: Recovery injection in `memento-activate.js` — reads bridge on `source=startup`,
  prepends `[CTX BRIDGE]` block to the session-start prompt.
- **New**: `memento-config.js` — `BRIDGE_TRIGGER_PCT=74`, `BRIDGE_SPIKE_TOKENS=3000`,
  `getCtxBridgePath`, `writeCtxBridge`, `readCtxBridge`, `deleteCtxBridge`.
- **User-visible impact**: None during normal sessions. At recovery: `[CTX BRIDGE] Written
  at X% | Files: ... | Next: "..." | Error: ...` appears alongside the normal `why` arc.

## v0.4.2 — 2026-05-22

Installer bug fixes.

- **Fix same-file copy error in `hooks/install.sh`**: When the top-level `install.sh` delegates to `hooks/install.sh`, `SCRIPT_DIR` resolves to the same path as `HOOKS_DIR` (both `~/.claude/hooks/`). The `cp` command fails with "are the same file". Fixed by adding a `SCRIPT_DIR != HOOKS_DIR` guard on both the hook-file copy loop and the SKILL.md copy — when paths match, falls through to curl download. Affected `--force` upgrades and fresh `curl | bash` installs.
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
