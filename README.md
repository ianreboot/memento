<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/memo_1f4dd.png" width="120" />
</p>

<h1 align="center">memento</h1>

<p align="center">
  <strong>automatic task recovery after context compaction — zero user intervention</strong>
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

Claude Code forgets everything when context compaction fires. Memento keeps a lightweight task journal on disk and re-injects it automatically, so Claude picks up exactly where it left off — no questions asked. Install takes 10 seconds, costs under 400 tokens per session, and runs invisibly in the background.

## The Problem

Context compaction is Claude Code's way of handling long sessions: when the context window fills, older conversation history is summarized and dropped. The task state you built up — what just ran, why it ran, what's next — is gone.

You run an analytics task. It drives a decision task. Compaction happens. Now Claude has no memory of:

- What the analytics task produced
- Why the analytics task was needed
- What decision task was supposed to come next

The best it can do is search for artifacts and reverse-engineer intent. That is slow, error-prone, and frustrating.

## How It Works

Memento uses two Claude Code hooks and a small JSON journal file:

```
Session starts
  └── SessionStart hook reads journal → injects into system context (invisible to you)

You send a message
  └── UserPromptSubmit hook checks for /clear → emits a brief reminder (invisible to you)

Claude completes a task
  └── Claude writes a journal entry to disk via the Write tool
        task name, result, context (what you said or what the tool showed)

Compaction happens
  └── SessionStart hook fires again → full journal re-injected → Claude resumes instantly
```

**Push-based recovery.** The hook injects the journal automatically on every session start — including after compaction. Claude does not need to know to ask for context; it arrives before the first message. This is the key difference from pull-based memory tools that require the AI to query a memory store — which a just-compacted Claude cannot reliably do on its own.

Nothing appears in your conversation. The journal is a background process.

## What Recovery Looks Like

After compaction fires, Claude sees this injected silently into its system context:

```
[MEMENTO] Mission: ship auth fix + pricing analysis | proj:myapp | path:/home/alice/.claude/.memento/alice.json
Sum: schema migration done, staging env configured
Done: fix auth middleware -> PASETO impl, expiry corrected | ctx: user said "auth is broken before deploy"
Done: analyze pricing -> 3 gaps, margins off 12% | ctx: pricing_check.py showed negative margin on SKU-47
WIP: deploy auth fix | connected to staging, pre-flight checks next
Next: pricing decision | run integration tests

Update journal after each task: write JSON to the path above using the Write tool.
```

Claude reads this before the first post-compaction message arrives and resumes without asking you to re-explain anything.

## Install

**Option 1 — Plugin (recommended):**
```bash
claude plugin install ianreboot/memento
```

**Option 2 — Standalone (curl):**
```bash
curl -fsSL https://raw.githubusercontent.com/ianreboot/memento/main/install.sh | bash
```

**Uninstall:**
```bash
# Plugin install:
claude plugin uninstall ianreboot/memento

# Standalone install:
bash ~/.claude/hooks/install.sh --uninstall
```

Requires Node.js 14.14+. Restart Claude Code after installing.

## What Gets Journaled

Each journal entry captures three things:

| Field | What it contains | Source |
|-------|-----------------|--------|
| `task` | What was done | Claude's description |
| `result` | What it produced (numbers, paths, key findings) | Direct from tool output |
| `ctx` | Why it was needed | Only what you said, or what a tool showed |

**The fidelity rule**: `ctx` only contains what you explicitly stated or what tool output directly showed. If the reason was not stated, `ctx` is omitted. Memento never infers or fabricates causal chains.

### What counts as a task

A task is a discrete action that changes project state or produces something you can act on:
- Fixing a bug
- Running an analysis
- Deploying code
- Making an architectural decision

**Not** a task: reading a file, running a status check, answering a question.

### In-progress tracking

If compaction fires mid-task — inside a deploy, mid-debug cycle, partway through a multi-file refactor — memento preserves the `in_progress` field so the recovered Claude knows exactly what was interrupted and where it left off.

### Mission state

The journal tracks whether the current mission is `active`, `blocked`, or `waiting`. If Claude was blocked on something when compaction fired, the next instance knows to investigate the blocker before proceeding rather than blindly moving on.

### Rolling window

The journal keeps the 8 most recent completed tasks plus up to 5 upcoming tasks. Older entries are folded into a one-line rolling summary. The journal file stays under 6KB and the context injection costs under 400 tokens — negligible against a 200k context window.

### Entry format

Entries are compressed (articles and filler dropped) to minimize token cost. Technical terms, numbers, file paths, and error strings are preserved exactly.

```
Done: fix auth middleware -> PASETO impl, expiry corrected | ctx: user said "auth is broken before deploy"
Done: analyze pricing -> 3 gaps, margins off 12% | ctx: pricing_check.py showed negative margin on SKU-47
Next: pricing decision | deploy auth fix
```

## What Memento Does Not Replace

Memento fills the gap between three existing layers:

| Layer | Purpose | Memento's relationship |
|-------|---------|----------------------|
| `CLAUDE.md` | Permanent project knowledge | Does not touch |
| `MEMORY.md` | Cross-session temporal notes | Does not touch |
| Conversation history | Full dialogue | Survives compaction where this does not |

## Mission Tracking

Memento infers the current mission from your first substantive request and tags all entries to it. The mission is a single sentence: what will exist or be decided when the work is done.

The mission closes automatically when you run `/clear`, change projects, or explicitly say you are switching to something different.

## Privacy and Data

**What is stored:** Task names, results, and the context (your words or tool output) that explains why each task was needed. Stored in `$CLAUDE_CONFIG_DIR/.memento/<username>.json`.

**What is not stored:** File contents, full command output, credentials, secrets, or any data you have not asked to track.

**Who can read it:** Only your local user account. Files are created with `0600` permissions (owner read/write only). Writes are atomic (temp file + rename) and symlink-safe — memento defends against symlink-clobber attacks at both the file and parent-directory level.

**How long it persists:** Entries older than 7 days are collapsed into a one-line summary. The journal resets to a summary when you run `/clear`.

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
| `MEMENTO_INSTANCE_TAG` | OS username | Override journal filename — use when running two Claude windows under the same OS user |
| `MEMENTO_MAX_FILE_KB` | `6` | Journal file size cap in KB |
| `MEMENTO_STALE_DAYS` | `7` | Days before entries are collapsed into a summary |
| `MEMENTO_DEBUG` | (unset) | Set to `1` to enable a shadow debug journal at `~/.claude/.memento/<tag>.debug.json` — records every write, prune, injection, and mission lifecycle event for post-session forensics |

Note: `MEMENTO_PROJECT_TAG` does not exist. The project field in the journal is auto-detected from the git repo name and needs no override.

## Contributing

Memento is open source and welcomes contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, development setup, and contribution guidelines.

Bug reports, feature ideas, and pull requests are all welcome at [github.com/ianreboot/memento](https://github.com/ianreboot/memento).
