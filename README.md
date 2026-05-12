<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/memo_1f4dd.png" width="120" />
</p>

<h1 align="center">memento</h1>

<p align="center">
  <strong>preserves intent across context compaction — the why behind your work, not just the what</strong>
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

Claude Code forgets the *why* when context compaction fires. Not just which task was running — but why it mattered, what constraints you set, and what the results mean for next steps. Memento preserves this automatically, so Claude can make correct decisions after context loss, not just resume the right task. Unlike memory tools that require Claude to query a store, memento *pushes* context automatically — so even a just-compacted Claude recovers without knowing it needs to ask. Install takes 10 seconds, adds ~350 tokens at session recovery (plus ~50 tokens per message during active work), and runs invisibly in the background.

## The Problem

Context compaction is Claude Code's way of handling long sessions: when the context window fills, older conversation history is summarized and dropped. The task state you built up — what just ran, why it ran, what's next — is gone.

You run an analytics task. It drives a decision task. Compaction happens. Now Claude has no memory of:

- What the analytics task produced
- Why the analytics task was needed
- What decision task was supposed to come next

The best it can do is search for artifacts and reverse-engineer intent. That is slow, error-prone, and frustrating.

## How It Works

Memento uses two Claude Code hooks, a SKILL.md behavioral spec, and a small JSON journal file:

```
Session starts
  └── SessionStart hook reads journal → injects into system context (invisible to you)

You send a message
  └── UserPromptSubmit hook checks for /clear → emits a brief reminder (invisible to you)

Information changes that compaction would destroy
  └── Claude writes a journal entry to disk via the Write tool
        task name, result, context (what you said or what the tool showed)
        (SKILL.md instructs Claude when and what to journal — the behavioral spec)

Compaction happens
  └── SessionStart hook fires again → full journal re-injected → Claude resumes instantly
```

**Push-based recovery — this is the key design decision.** The hook injects the journal automatically on every session start, including after compaction. Claude does not need to know to ask for context; it arrives before the first message. Pull-based memory tools require the AI to query a store — but a just-compacted Claude has no memory of what to query. Memento sidesteps this entirely.

Nothing appears in your conversation. The journal is a background process. Journal writes appear as Write tool calls in your tool stream — this is visible confirmation that memento is saving your work, not conversation content. Hook output (the context injection itself) is never visible.

## What Recovery Looks Like

After compaction fires, Claude sees this injected silently into its system context:

```
[MEMENTO] Mission: ship auth fix + pricing analysis -- deploy to staging only, no token format changes -- done when: tests pass + health check green | proj:myapp | path:/home/alice/.claude/.memento/alice.json
Sum: schema migration done, staging env configured
Done: fix auth middleware -> PASETO impl, expiry corrected | ctx: user: auth is broken before deploy
Done: analyze pricing -> 3 gaps, margins off 12% | ctx: note: margin loss on SKU-47 means pricing model must be revised before Q3 launch
WIP: deploy auth fix — connected to staging, pre-flight checks next
Plan: pricing decision | run integration tests
```

Claude reads this before the first post-compaction message arrives and resumes without asking you to re-explain anything.

## How Reliable Is It?

Memento's hooks — context injection, pruning, mission lifecycle — are fully automatic and reliable. Journal writes depend on Claude executing the Write tool after each task. In focused sessions this works well. In very complex or high-pressure work, Claude may occasionally miss a write.

To see what memento has saved at any point: `"what does memento have on this session?"` Claude reads and displays the journal directly.

For maximum coverage during a critical session, you can prompt a catch-up write at any time: `"update the memento journal before we continue."` This is the manual fallback when you want a guaranteed checkpoint.

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

Each journal entry captures three things:

| Field | What it contains | Source |
|-------|-----------------|--------|
| `act` | What was done | Claude's description |
| `result` | What it produced (numbers, paths, key findings) | Direct from tool output |
| `ctx` | Why it mattered — and what it means for next steps | Only what you said, or what a tool showed |

**The fidelity rule**: `ctx` only contains what you explicitly stated or what tool output directly showed. If the reason was not stated, `ctx` is omitted. Memento never infers or fabricates causal chains.

**ctx typed prefixes** tell a recovering Claude how to trust the context:
- `user: <exact words>` — what you said (authoritative; drives recovery behavior)
- `tool: <output snippet>` — what a tool showed (may be stale; verify before acting on it)
- `note: <forward causation>` — a result means Claude should... (e.g., "note: margin loss on SKU-47 means Q3 launch must hold until pricing revised")

### What counts as a task

A task is a discrete action that changes project state or produces something you can act on:
- Fixing a bug
- Running an analysis
- Deploying code
- Making an architectural decision

**Not** a task: reading a file, running a status check, answering a question.

### WIP tracking

The most dangerous compaction scenario is mid-task: a half-deployed service, a partially refactored codebase, an interrupted multi-file edit. Memento's `wip` field is specifically designed for this: a plain string capturing exactly where you are and what is blocked, so the recovered Claude can verify and resume rather than starting over or guessing.

Examples: `"deploy auth service — build passed, uploading assets"` or `"blocked: auth test 401 on valid token — root cause unknown"`.

`wip` also works for **research and advisory sessions** where there are no discrete task completions. Set it after meaningful progress to capture current decision state — what's been eliminated, what remains, the open question. This is the write trigger for exploratory work: `"brand naming — IQ/combo/HomeDIY eliminated | candidates: crestven, ridgven | open: user deciding"`.

### Rolling window

The journal keeps the 6 most recent done entries (configurable via `MEMENTO_MAX_ENTRIES`) plus up to 3 plan items. Older entries are folded into a rolling summary that preserves both task names and causal context. The journal file stays under 6KB and each session-start injection costs under 350 tokens — negligible against a 200k context window. The UserPromptSubmit hook adds a ~50-token per-message reminder while an active mission is open. See [docs/session-validation.md](docs/session-validation.md) for real-session measurements.

### Entry format

Entries are compressed (articles and filler dropped) to minimize token cost. Technical terms, numbers, file paths, and error strings are preserved exactly.

```
Done: fix auth middleware -> PASETO impl, expiry corrected | ctx: user: auth is broken before deploy
Done: analyze pricing -> 3 gaps, margins off 12% | ctx: note: margin loss on SKU-47 means Q3 launch must hold until pricing revised
Plan: pricing decision | deploy auth fix
```

## What Memento Does Not Replace

Memento fills the gap between three existing layers:

| Layer | Purpose | Memento's relationship |
|-------|---------|----------------------|
| `CLAUDE.md` | Permanent project knowledge | Does not touch |
| `MEMORY.md` | Cross-session temporal notes | Does not touch |
| Conversation history | Full dialogue | Survives compaction where this does not |

**When to use each layer:**
- **Memento**: intent and causal context within focused work sessions — goals, constraints, done entries with causal reasoning. Automatic.
- **MEMORY.md**: system state, active process ownership, multi-week project checkpoints, anything with a natural expiry. Requires manual upkeep.
- **CLAUDE.md**: permanent architecture decisions, API facts, code patterns — anything that should be true across every future session regardless of mission. Requires manual upkeep.

## Mission Tracking

Memento captures the mission from your first substantive request — close to verbatim, including constraints and definition of done: `"fix auth pipeline -- don't change token format -- done when: tests pass + staging health check green"`.

The mission closes automatically when you run `/clear`, change projects, or explicitly say you are switching to something different.

## Privacy and Data

**What is stored:** Task names, results, and the context (your words or tool output) that explains why each task was needed. Stored in `$CLAUDE_CONFIG_DIR/.memento/<username>.json`.

**What is not stored:** File contents, full command output, credentials, secrets, or any data you have not asked to track. The UserPromptSubmit hook reads each message to detect mission-closing phrases (`/clear`, project-shift language); this text is never stored, logged, or transmitted.

**Who can read it:** Only your local user account. Files are created with `0600` permissions (owner read/write only). Writes are atomic (temp file + rename) and symlink-safe — memento defends against symlink-clobber attacks at both the file and parent-directory level.

**How long it persists:** When the newest completed entry is older than 7 days, all entries are collapsed into a one-line summary. The journal resets to a summary when you run `/clear`.

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

## Configuration

All settings are optional. Memento works out of the box with no configuration.

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `MEMENTO_INSTANCE_TAG` | OS username | Override journal filename — use when two Claude windows share an OS user, or multiple users share a machine account |
| `MEMENTO_MAX_ENTRIES` | `6` | Maximum done entries to keep (range 4–24). Higher values improve recovery for long sessions at negligible token cost. |
| `MEMENTO_MAX_FILE_KB` | `6` | Journal file size cap in KB |
| `MEMENTO_STALE_DAYS` | `7` | Days before a closed mission's entries collapse into a summary. Active missions use 2× this threshold. |
| `MEMENTO_DEBUG` | (unset) | Set to `1` to enable a shadow debug journal at `~/.claude/.memento/<tag>.debug.json` — records every write, prune, injection, and mission lifecycle event for post-session forensics |

Note: `MEMENTO_PROJECT_TAG` does not exist. The project field in the journal is auto-detected from the git repo name and needs no override.

**Shared accounts**: If multiple users or Claude windows share the same OS user account, set a unique `MEMENTO_INSTANCE_TAG` per instance to prevent journal collisions (e.g. `MEMENTO_INSTANCE_TAG=alice` and `MEMENTO_INSTANCE_TAG=bob`).

## Upgrading from v0.1.x

v0.2.0 renames several journal fields. **No migration needed** — old journals are read transparently and normalized to new names on the next journal write.

| Old field | New field | Notes |
|-----------|-----------|-------|
| `completed[]` | `done[]` | Same entries, renamed |
| `upcoming[]` | `plan[]` | Same items, renamed |
| `in_progress.progress` | `wip` | Flattened to a plain string |
| `task` (in entry) | `act` | Same value, renamed |
| `state` / `state_reason` | (dropped) | Fold blocker info into `wip` string |

Old journals continue to inject correctly. On the first time Claude writes the journal after upgrading, it will adopt the new field names automatically.

## Contributing

Memento is open source and welcomes contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, development setup, and contribution guidelines.

Bug reports, feature ideas, and pull requests are all welcome at [github.com/ianreboot/memento](https://github.com/ianreboot/memento).
