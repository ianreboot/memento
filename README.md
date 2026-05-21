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

Context compaction erases more than task history — it erases intent. A recovering Claude might know it was fixing auth, but not that the constraint was "staging only, no token format changes." Memento captures the *why* before every compaction and surfaces it at recovery, so Claude picks up with the same reasoning, not just the same task.

Unlike memory tools that require Claude to query a store, memento *pushes* context automatically — so even a just-compacted Claude recovers without knowing it needs to ask. Install takes 10 seconds, adds ~100–200 tokens at session recovery (depending on history depth), and runs invisibly in the background.

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

Memento uses three Claude Code hooks, a SKILL.md behavioral spec, and a small JSON journal file:

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

Compaction happens
  └── SessionStart fires again → previous why + intent arc re-injected → Claude resumes
```

**Push-based recovery — this is the key design decision.** The hook injects the journal automatically on every session start, including after compaction. Claude does not need to know to ask for context; it arrives before the first message. Pull-based memory tools require the AI to query a store — but a just-compacted Claude has no memory of what to query. Memento sidesteps this entirely.

Nothing appears in your conversation. The journal is a background process. Journal writes appear as Write tool calls in your tool stream — visible confirmation that memento is saving your work, not conversation content.

## What Recovery Looks Like

After compaction fires, Claude sees this injected silently into its system context:

```
[MEMENTO] Recovering | path: /home/alice/.claude/.memento/alice.json
Why: "fix auth middleware, mobile 401s — staging only, no token format changes" | Set: 2026-05-21T14:00:00Z
Arc: "setup project" → "implement auth pipeline" → "fix auth middleware, mobile 401s — staging only, no token format changes"
MANDATORY WRITE — Why are we doing this? Confirm or update why before your first tool call. [GUESS] always valid.
```

Claude reads this before the first post-compaction message arrives and resumes with the correct intent — including constraints — without asking you to re-explain anything.

## How Reliable Is It?

Writes are mandatory every turn. Before every response, Claude receives a MANDATORY WRITE prompt and must write `{why, when, why_history}` to disk. [GUESS] is always valid — Claude never gets stuck deciding what to write, even in sessions where intent has not been stated explicitly.

To see what memento has saved at any point: `"what does memento have on this session?"` Claude reads and displays the journal directly.

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

**What is stored:** Current intent and intent history. Stored in `$CLAUDE_CONFIG_DIR/.memento/<username>.json`.

**What is not stored:** File contents, full command output, credentials, secrets, task results, or any data you have not asked to track. The UserPromptSubmit hook reads the turn counter and journal — it does not parse your message content.

**Who can read it:** Only your local user account. Files are created with `0600` permissions (owner read/write only). Writes are atomic (temp file + rename) and symlink-safe — memento defends against symlink-clobber attacks at both the file and parent-directory level.

**To see what is in your journal:**
```
Ask Claude: "what does memento have on this session?"
```

**To clear a journal manually:**
```bash
rm ~/.claude/.memento/<username>.json
```

**To see all journals:**
```bash
ls ~/.claude/.memento/
```

**To edit a journal directly:**

Direct JSON edits are supported and intentional — they are the escape hatch when Claude writes something wrong and you want to fix it without waiting for Claude to correct itself.

```bash
nano ~/.claude/.memento/<username>.json
```

Keep it valid JSON and avoid newlines inside string values. The hook re-reads the file on every session start and every user prompt, so changes take effect immediately — no restart needed.

## Configuration

All settings are optional. Memento works out of the box with no configuration.

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `MEMENTO_INSTANCE_TAG` | OS username | Override journal filename — use when two Claude windows share an OS user, or multiple users share a machine account |
| `MEMENTO_MAX_FILE_KB` | `6` | Journal file size cap in KB |
| `MEMENTO_DEBUG` | (unset) | Set to `1` to enable a shadow debug journal at `~/.claude/.memento/<tag>.debug.json` |

Note: `MEMENTO_MAX_ENTRIES` and `MEMENTO_STALE_DAYS` were removed in v0.4.0 — the intent journal has no rolling window.

**Shared accounts**: If multiple users or Claude windows share the same OS user account, set a unique `MEMENTO_INSTANCE_TAG` per instance (e.g. `MEMENTO_INSTANCE_TAG=alice` and `MEMENTO_INSTANCE_TAG=bob`).

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
