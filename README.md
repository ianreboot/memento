<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/memo_1f4dd.png" width="120" />
</p>

<h1 align="center">memento</h1>

<p align="center">
  <strong>remembers the why behind your work, not just the what</strong>
</p>

<p align="center">
  <a href="https://github.com/ianreboot/memento/stargazers"><img src="https://img.shields.io/github/stars/ianreboot/memento?style=flat&color=blue" alt="Stars"></a>
  <a href="https://github.com/ianreboot/memento/commits/main"><img src="https://img.shields.io/github/last-commit/ianreboot/memento?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ianreboot/memento?style=flat" alt="License"></a>
  <a href="https://github.com/ianreboot/memento/actions/workflows/test.yml"><img src="https://github.com/ianreboot/memento/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

<p align="center">
  <a href="#the-problem">Problem</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#what-recovery-looks-like">Recovery Demo</a> •
  <a href="#install">Install</a> •
  <a href="#what-gets-journaled">What Gets Journaled</a> •
  <a href="#privacy-and-data">Privacy</a> •
  <a href="#contributing">Contributing</a>
</p>

---

You tell Claude the constraints at the start of a session. An hour later, compaction fires. Claude's summary captures the task list but loses the reasoning. It no longer knows why you're doing it, what's off-limits, or what decision was made and why. Now it's working with the same tasks but wrong assumptions. Or it asks you to re-explain something you already explained.

Memento fixes this. It captures the *why* before every compaction and injects it at recovery, so Claude resumes with the same reasoning, not just the same task list.

Unlike memory tools that require Claude to query a store, memento *pushes* context automatically. A just-compacted Claude doesn't need to know it should ask for context — it's already there. Install takes 10 seconds, adds ~100–200 tokens at session recovery, and runs invisibly in the background.

## The Problem

Context compaction is Claude Code's way of handling long sessions: when the context window fills, older conversation history is summarized and dropped. The task state you built up — what just ran, why it ran, what constraints apply — is gone.

You run an analytics task. It drives a decision task. Compaction happens. Now Claude has no memory of:

- What the analytics task produced
- Why the analytics task was needed
- What constraints you established before work began

The best it can do is search for artifacts and reverse-engineer intent. That is slow, error-prone, and frustrating. The deeper problem: it may proceed with the wrong interpretation of what you wanted.

**Two scenarios where this costs you:**

**Mid-task compaction.** When compaction fires mid-task — before any summary exists — the native summary is empty. Memento has captured current intent at the start of every turn, so the recovering Claude knows exactly what it was trying to accomplish and can resume correctly.

**Multi-session intent drift.** After many compactions, native summaries reset each time. Memento's `why_history` persists how your intent evolved across every compaction boundary — the constraints, the pivots, the reasoning — so a recovering Claude doesn't just resume the task, it resumes with the same understanding.

## How It Works

Memento uses four Claude Code hooks, a SKILL.md behavioral spec, and a small JSON journal file:

```
Session starts
  └── SessionStart hook reads journal → resets turn counter → injects prompt (invisible to you)

You send a message
  └── UserPromptSubmit hook emits MANDATORY WRITE prompt with turn number (invisible to you)

Claude writes why+when+why_history to disk before responding
      [GUESS] is always valid — Claude writes its best inference even with zero context
      Same why is valid if intent has not changed
      why_history updated only when why changes

Pre-compaction
  └── PreCompact hook fires → "MANDATORY WRITE — LAST WRITE OPPORTUNITY" prompt
      Hook also writes a ctx_bridge snapshot via AI extraction from the session transcript

Session ends (clean exit, crash, or interrupt)
  └── SessionEnd hook fires → writes minimal ctx_bridge from current journal intent

Compaction happens / next session starts
  └── SessionStart fires → previous why + intent arc re-injected → ctx_bridge injected if present
```

**Push-based recovery — this is the key design decision.** The hook injects the journal automatically on every session start, including after compaction. Claude does not need to know to ask for context; it arrives before the first message. Pull-based memory tools require the AI to query a store — but a just-compacted Claude has no memory of what to query. Memento sidesteps this entirely.

## Context Bridge

When context usage reaches 74%, memento automatically writes a pre-compaction snapshot called `ctx_bridge-{conversationHash}.json`. This captures structured recovery data — not just intent, but the specific files being edited and the exact next action to take.

```json
{
  "files": ["src/auth.js", "tests/auth.test.js"],
  "next":  "fix the 401 on line 47, then run npm test",
  "err":   "TypeError: Cannot read property 'token' of undefined",
  "pct":   76,
  "at":    "2026-05-23T14:30:00Z"
}
```

**Three safety nets ensure the bridge is written before any session end:**

1. **At 74% context:** UserPromptSubmit detects ≥74% usage and injects a `[BRIDGE]` directive — Claude writes the bridge with exact files, next step, and current error.
2. **Before compaction:** PreCompact hook uses AI extraction from the session transcript to write the bridge, even if Claude missed the 74% directive.
3. **On clean exit:** SessionEnd hook writes a minimal bridge from the current journal intent — covering sessions that end without ever compacting.

Only the richest available bridge is used. A bridge written at 74% by Claude is never overwritten by the hook fallbacks. On the next session start, the bridge is injected into recovery context and deleted.

**User-visible impact:** None. The bridge is written and consumed silently. On recovery, the extra `[CTX BRIDGE]` line appears in the injected context alongside the normal `why` arc.

**Override:** Set `MEMENTO_CONTEXT_WINDOW_TOKENS=<n>` if your model has a different context window than the 200,000-token default.

Nothing appears in your conversation. The journal is a background process. Journal writes appear as Bash tool calls in your tool stream — visible confirmation that memento is saving your work, not conversation content.

## What Recovery Looks Like

After compaction fires, Claude sees this injected silently into its system context:

```
[MEMENTO] Recovering | path: /home/alice/.claude/.memento/alice-a3f9c1b2.json
Why: "fix auth middleware, mobile 401s — staging only, no token format changes" | Set: 2026-05-21T14:00:00Z
Arc: "setup project" → "implement auth pipeline" → "fix auth middleware, mobile 401s — staging only, no token format changes"
MANDATORY WRITE — Why are we doing this? Confirm or update why (purpose, not action) before your first tool call. [GUESS] always valid.
node ~/.claude/hooks/memento-write-why.js '<your why>'
```

When a ctx_bridge was written (74%+ or session end), the recovery includes a second block with structured resumption state:

```
[CTX BRIDGE] Written at 76% | Files: src/auth.js, tests/auth.test.js
Prior session: "fix the 401 on line 47, then run npm test" - verify still relevant
Read the listed files before resuming work.

[MEMENTO] Recovering | path: /home/alice/.claude/.memento/alice-a3f9c1b2.json
Why: "fix auth middleware, mobile 401s — staging only, no token format changes" | Set: 2026-05-21T14:00:00Z
Arc: "setup project" → "implement auth pipeline" → "fix auth middleware, mobile 401s — staging only, no token format changes"
MANDATORY WRITE — Why are we doing this? Confirm or update why (purpose, not action) before your first tool call. [GUESS] always valid.
node ~/.claude/hooks/memento-write-why.js '<your why>'
```

The `Prior session:` line is informational, not a directive. If the user's opening message redirects to a different task, Claude treats it as cleared and follows the user's lead.

Claude reads both blocks before the first post-compaction message arrives and resumes with the correct intent — including constraints — without asking you to re-explain anything.

## How Reliable Is It?

Writes are mandatory every turn. Before every response, Claude receives a MANDATORY WRITE prompt and must run the write command to capture current intent to disk. [GUESS] is always valid — Claude never gets stuck deciding what to write, even in sessions where intent has not been stated explicitly.

To see what memento has saved at any point: `"what does memento have on this session?"` Claude reads and displays the journal directly.

## Why the PreCompact Hook Uses an Inference Call

The PreCompact hook is a shell process. Claude Code calls it before compaction, reads its stdout as a prompt injection, then proceeds. The hook runs and exits — it cannot wait for Claude to respond, and Claude may not be able to use tool calls during compaction.

The only way to write a structured `ctx_bridge` snapshot (files, next step, error) at the PreCompact boundary — when no tracker bridge exists — is to spawn a separate `claude -p` process that reads the session transcript tail and extracts recovery state. Without this, the only fallback is the minimal bridge from `journal.why` (no files, no structured next step) — the same low-fidelity bridge SessionEnd writes.

This is architecturally load-bearing. The hook system is one-way: hooks write to stdout and exit. There is no mechanism for a hook to wait for Claude to respond or write files. `claude -p` is the only way to perform AI extraction at compaction time.

## Install

**Option 1 — Plugin (recommended):**
```
/plugin marketplace add ianreboot/memento
/plugin install memento@ianreboot-memento
```

**Option 2 — Standalone (curl):**
```bash
curl -fsSL https://raw.githubusercontent.com/ianreboot/memento/main/install.sh | bash
```

**Uninstall:**
```
# Plugin install:
/plugin uninstall memento@ianreboot-memento

# Standalone install:
bash ~/.claude/hooks/install.sh --uninstall
```

Requires Node.js 14.14+. Restart Claude Code after installing.

**Verify:** In a new session, ask Claude: `"what does memento have on this session?"` — Claude should confirm the journal path and acknowledge no prior journal exists yet.

If memento saves you from re-explaining yourself, [star the repo](https://github.com/ianreboot/memento/stargazers) to help others find it.

## What Gets Journaled

The journal captures three fields:

| Field | What it contains |
|-------|-----------------|
| `why` | Current intent — what you are trying to accomplish and why. Plain language, max 200 chars. Can start with `[GUESS]` when intent is inferred rather than stated. |
| `when` | ISO timestamp of the last write |
| `why_history` | Array of previous `why` values — how intent evolved across the session. Appended only when `why` changes. Capped at 10 entries, oldest dropped first. |

**[GUESS] writes**: When Claude cannot confirm intent from a direct user statement, it writes `[GUESS] probably <inference>`. This is always valid and preferred over skipping the write. A guessed why is more useful for recovery than no why at all.

**Same-why writes**: If intent has not changed, Claude writes the same `why` with an updated `when`. The write still happens — only `why_history` is unchanged.

### Example journal

```json
{
  "why": "fix auth middleware, mobile 401s — staging only, no token format changes",
  "when": "2026-05-21T14:32:00Z",
  "why_history": [
    {"w": "setup project structure", "t": "2026-05-21T12:00:00Z"},
    {"w": "implement auth pipeline", "t": "2026-05-21T13:15:00Z"}
  ]
}
```

## What Memento Does Not Replace

Memento fills the gap between three existing layers:

| Layer | Purpose | Memento's relationship |
|-------|---------|----------------------|
| `CLAUDE.md` | Permanent project knowledge | Does not touch |
| `MEMORY.md` | Cross-session temporal notes | Does not touch |
| Conversation history | Full dialogue | Survives compaction where this does not |

**When to use each layer:**
- **Memento**: intent and reasoning within focused work sessions — why you are doing this, what constraints apply, how the goal has evolved. Automatic.
- **MEMORY.md**: system state, active process ownership, multi-week project checkpoints, anything with a natural expiry. Requires manual upkeep.
- **CLAUDE.md**: permanent architecture decisions, API facts, code patterns — anything that should be true across every future session. Requires manual upkeep.

## Privacy and Data

**What is stored:** Current intent and intent history. Stored in `$CLAUDE_CONFIG_DIR/.memento/<username>-<conversationHash>.json`. Each conversation gets its own file — two Claude Code windows in the same project directory never share a journal.

**Cross-instance sessions**: memento is per-session and per-instance. Journal context does not transfer across instances (different containers, parallel sessions, or hand-offs to another user's Claude). For cross-instance work, write an explicit handoff file — the receiving instance starts with a blank journal.

**What is not stored:** File contents, full command output, credentials, secrets, task results, or any data you have not asked to track. The UserPromptSubmit hook reads the turn counter and journal — it does not parse your message content.

**Who can read it:** Only your local user account. Files are created with `0600` permissions (owner read/write only). Writes are atomic (temp file + rename) and symlink-safe — memento defends against symlink-clobber attacks at both the file and parent-directory level.

**To see what is in your journal:**
```
Ask Claude: "what does memento have on this session?"
```

**To clear a journal manually:**
```bash
rm ~/.claude/.memento/<username>-<conversationHash>.json
```

The conversation hash is the 8-char hex shown in the `path:` field of every memento prompt. To find it: look at the last `[MEMENTO] MANDATORY WRITE | Turn N | path: ...` line injected at session start, or ask Claude: `"what is your memento journal path?"`

**To see all journals:**
```bash
ls ~/.claude/.memento/
```

**To edit a journal directly:**

Direct JSON edits are supported and intentional — they are the escape hatch when Claude writes something wrong and you want to fix it without waiting for Claude to correct itself.

```bash
nano ~/.claude/.memento/<username>-<conversationHash>.json
```

Keep it valid JSON and avoid newlines inside string values. The hook re-reads the file on every session start and every user prompt, so changes take effect immediately — no restart needed.

## Configuration

All settings are optional. Memento works out of the box with no configuration.

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `MEMENTO_INSTANCE_TAG` | OS username | Override instance tag portion of journal filename — use when multiple users share a machine account |
| `MEMENTO_PROJECT_HASH` | SHA-1 of active JSONL path | Override conversation hash for testing or non-git contexts. 8-char hex string. When set, `resolveConversation()` returns it directly without scanning for a JSONL file. |
| `MEMENTO_MAX_FILE_KB` | `6` | Journal file size cap in KB |
| `MEMENTO_DEBUG` | (unset) | Set to `1` to enable a shadow debug journal at `~/.claude/.memento/<tag>-<hash>.debug.json` |
| `MEMENTO_CONTEXT_WINDOW_TOKENS` | `200000` | Override context window size for the 74% bridge threshold — use if your model has a different context window |
| `MEMENTO_CLAUDE_BIN` | `claude` | Override the `claude` binary path used for transcript extraction in the PreCompact hook (useful for testing) |

Note: `MEMENTO_MAX_ENTRIES` and `MEMENTO_STALE_DAYS` were removed in v0.4.0 — the intent journal has no rolling window.

**Shared accounts**: If multiple users or Claude windows share the same OS user account, set a unique `MEMENTO_INSTANCE_TAG` per instance (e.g. `MEMENTO_INSTANCE_TAG=alice` and `MEMENTO_INSTANCE_TAG=bob`).

## Upgrading from v0.6.x to v0.7.0

**Breaking change**: journal files are now namespaced per conversation (SHA-1 of JSONL path) rather than per project (SHA-1 of git root). v0.6.x files will not be found on upgrade.

After upgrading, the first session in each project produces a "No prior journal" Turn 1 prompt — the same as first-install behavior. Claude creates a fresh journal at the new conversationHash path. Existing intent history from v0.6.x is not migrated.

**Clean up old files**: v0.6.x files (`{instanceTag}-{projectHash}.json` and associated `.turn`/`.last_ctx` sidecars) remain in `~/.claude/.memento/` as inert files. Safe to delete after confirming the new session is journaling correctly. New files follow: `{instanceTag}-{8charHex}.json` where the hash derives from the JSONL path, not the git root.

**What you get**: parallel Claude Code sessions in the same project directory now have fully isolated state — no configuration required. Previously, two Claude windows in the same repo shared a journal and could overwrite each other.

**New files** (per-instance, no hash):
- `{instanceTag}.anchor` — stores the active JSONL path; written once at session start
- `{instanceTag}.turn` — turn counter (was `{instanceTag}-{projectHash}.turn`)
- `{instanceTag}.last_ctx` — ctx% from previous turn (was `{instanceTag}-{projectHash}.last_ctx`)

## Upgrading from v0.5.x to v0.6.0

**Breaking change**: journal and ctx_bridge files are now namespaced per project. Files from v0.5.x will not be found on upgrade.

After upgrading, the first session in each project produces a "No prior journal" Turn 1 prompt — the same as first-install behavior. Claude creates a fresh journal at the new namespaced path. Existing intent history from v0.5.x is not migrated.

**Clean up old files**: v0.5.x files (`{instanceTag}.json`, `ctx_bridge.json`) remain in `~/.claude/.memento/` as inert files. Safe to delete:
```bash
# Review first
ls ~/.claude/.memento/

# Delete old-format files (named without a project hash)
# New files follow: {instanceTag}-{8charHex}.json
```

**What you get**: parallel Claude Code sessions in different project directories now have fully isolated state — no configuration required.

## Upgrading from v0.3.x and earlier

v0.4.0 replaces the mission/done/plan/wip schema entirely. Journals written before v0.4.0 (no `why` field) are treated as non-existent — Claude will be prompted to start a fresh journal. Prior journal content is not migrated.

To carry forward relevant context manually, write a v0.4.0 journal before starting your session:

```json
{
  "why": "your current intent here",
  "when": "2026-05-21T00:00:00Z",
  "why_history": []
}
```

Save it to `~/.claude/.memento/<your-username>.json` with `chmod 600`.

## Contributing

Memento is open source and welcomes contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, development setup, and contribution guidelines.

Bug reports, feature ideas, and pull requests are all welcome at [github.com/ianreboot/memento](https://github.com/ianreboot/memento).
