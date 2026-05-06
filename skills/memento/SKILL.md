---
name: memento
description: >
  Persistent task memory across context compaction. Maintains a rolling journal of
  completed tasks, their results, and causal context so Claude can recover mid-task
  after compaction without human intervention. Always active. Invisible to user.
  Triggers automatically — no slash command needed.
---

# Memento

Maintain a lightweight, mission-scoped task journal that survives context compaction.
The journal is a small JSON file on disk. Claude writes it. Hooks read and inject it.

## Architecture

Understanding who does what prevents confusion:

| Component | Role |
|-----------|------|
| **This SKILL.md** | Instructs Claude when and how to write journal entries |
| **`memento-activate.js`** (SessionStart hook) | Reads journal, injects it as system context |
| **`memento-tracker.js`** (UserPromptSubmit hook) | Detects mission-close events, emits reminder |
| **Claude (you)** | Writes journal entries via the Write tool after task completion |

Claude is the primary writer — all task entries come from Claude. Hooks may write to the journal for housekeeping only: pruning stale entries, closing missions on /clear, and updating the project tag. Hooks never create task entries.

## Journal Location

**One journal per Claude instance** (e.g. `alice`, `ubuntu`, etc.), regardless of which project is active. The file path is based on the OS username, not the project.

The hook always emits a `[MEMENTO]` header at session start — even when no journal exists yet:

```
[MEMENTO] No prior journal | instance:alice | proj:myapp | path:/home/alice/.claude/.memento/alice.json
Create journal at the path above when the mission is clear. Set project field to "myapp".
```

Or when a journal exists:

```
[MEMENTO] Mission: <mission> | proj:<current-project> | path:<journal-path>
```

**Always use the exact path shown in the header. Never derive the path yourself.**

The `proj:` field in the header shows the current project detected from git — update `journal.project` to match this whenever you write the journal. The hook auto-updates `project` at session start, but Claude should keep it current mid-session too.

If no `[MEMENTO]` header appears (hook failure), the path is `~/.claude/.memento/<username>.json`. Create the `.memento/` directory first if it does not exist (`mkdir -p` via Bash).

## Journal `project` Field

The `project` field tracks what's being worked on right now — not the journal file name. Update it when you switch projects:

```json
"project": "myapp"   // → "webapp" when you switch
```

When switching projects, also open a new mission (new `mission_opened`, clear `mission_closed`, reset `completed`/`upcoming`). Keep `summary` as historical context if relevant.

## Journal Schema

```json
{
  "mission":        "string — one sentence describing the current goal (max 200 chars)",
  "mission_opened": "ISO 8601 timestamp",
  "mission_closed": "ISO 8601 timestamp or null",
  "project":        "string — project tag (from hook header)",
  "summary":        "string or null — rolling summary of pruned entries (max 300 chars)",
  "state":          "string — 'active' | 'blocked' | 'waiting'",
  "state_reason":   "string or null — why blocked/waiting (max 120 chars)",
  "in_progress":    "object or null — { task, started, progress } for mid-task tracking",
  "completed": [
    {
      "task":   "string — what was done (max 80 chars)",
      "result": "string — what it produced (max 120 chars)",
      "ctx":    "string — typed context: user:... | tool:... | note:... (max 120 chars, omit if none)",
      "ts":     "ISO 8601 timestamp"
    }
  ],
  "upcoming": ["string — next task + one concrete anchor (max 150 chars)", "..."]
}
```

**Field limits are hard constraints** — truncate before writing. The journal file must stay under 6KB. If it would exceed 6KB after an update, prune `completed` first (fold oldest into `summary`), then write.

## What Counts as a Task

A task is a discrete action that changes project state or produces something the user can act on.

**Is a task:**
- Fixing a bug
- Deploying code
- Running an analysis and producing a result
- Making an architectural decision
- Completing a refactor

**Is not a task:**
- Reading a file to understand context (no action taken as a result)
- Running a status check with no follow-up action
- Answering a factual question
- A single bash command that is part of a larger task

When in doubt: if the user could meaningfully say "did you do X yet?", it is a task.

**Edge case**: If a "status check" or "question" reveals something actionable and you act on it (e.g., "run the tests" reveals failures and you start fixing them), the discovery is the task. Journal it.

## Writing Journal Entries — The Fidelity Rule

**Compress format, not facts.**

Every field must reflect only what was directly stated by the user or observed in tool output. Never infer, assume, or fabricate entry content.

| Field | What to write | What NOT to write |
|-------|---------------|-------------------|
| `task` | Short name of the completed action | Inferred intent or assumed purpose |
| `result` | Actual output: numbers, file paths, status codes, key findings | Your narrative interpretation of the result |
| `ctx` | One of three typed forms (see below) | Unprefixed narrative or invented quotes |

### ctx typed prefixes

The `ctx` field accepts exactly three forms — always use the prefix so a recovering Claude knows what kind of information it is:

- `user: <exact words>` — user's triggering statement
- `tool: <output snippet>` — tool output that caused this task
- `note: <recovery hint>` — critical context the next session needs (e.g., "note: resumed after compaction, second attempt")

If none of these applies, **omit `ctx` entirely**. An absent ctx is honest. A fabricated one misleads the next Claude instance.

**Good entries:**
```json
{
  "task": "fix auth middleware",
  "result": "PASETO impl, token expiry corrected",
  "ctx": "user: auth is broken before deploy",
  "ts": "2026-05-05T07:30:00Z"
}
```
```json
{
  "task": "analyze pricing model",
  "result": "3 gaps found, margins off 12%",
  "ctx": "tool: pricing_check.py showed negative margin on SKU-47",
  "ts": "2026-05-05T08:15:00Z"
}
```
```json
{
  "task": "deploy auth service (attempt 2)",
  "result": "deployed to staging, health check passed",
  "ctx": "note: first attempt failed mid-upload; resumed from upload step",
  "ts": "2026-05-05T09:00:00Z"
}
```

## Write Timing

**Write the journal as soon as each task completes, not at the end of the response.**

If you complete 3 tasks in one response, issue 3 separate Write tool calls — one after each task. Batching all writes to the end of the response defeats the purpose: if compaction fires mid-response, nothing is saved.

**Practical rule**: After any action that passes the "did you do X yet?" test, immediately write the journal before starting the next action.

For `in_progress`: write the journal with `in_progress` set *before* you issue the first tool call for a multi-step or async task. Update `progress` after each sub-step by writing again. If a task is fast (single tool call, completes in one step), skip `in_progress` and go straight to a `completed` entry.

## Entry Compression

Keep entries terse. Omit articles (a/an/the) and filler words. Abbreviate common terms (`auth`, `db`, `cfg`, `impl`, `env`, etc.). Preserve numbers, file paths, function names, and error strings exactly.

Priority: factual completeness over grammatical correctness. `"fix auth middleware PASETO expiry"` is better than `"Fixed the authentication middleware's PASETO token expiry handling."`

## Mission

The mission is a single sentence describing the overarching goal of the current work session.

**Inferring the mission:** Read the first substantive user request. State the mission in terms of what will exist or be decided when the work is done.

Good: `"deploy auth pipeline to production"`
Good: `"decide pricing model for Q3 launch"`
Bad: `"help user with auth"` (vague, no deliverable)
Bad: `"check some things"` (not yet substantive — set to `[pending]` and update when clear)

**Mission lifecycle:**
- Open: set `mission_opened` to current timestamp, `mission_closed` to null
- Close: the UserPromptSubmit hook sets `mission_closed` when it detects `/clear` or explicit project-shift commands. You do not need to handle these.
- **Claude-driven closure:** If you complete the last upcoming task and the user confirms satisfaction ("that's done", "ship it", "looks good"), set `mission_closed` to the current timestamp, `upcoming` to `[]`, and `state_reason` to `"mission complete"`. Do not wait for the hook — a closed mission is a clear signal to the next session that this work is finished.
- New mission: when `mission_closed` is set and the user starts working on something new, write a new journal with `mission_opened` reset and `mission_closed` null. Preserve old `summary` as historical context if relevant.

**`[pending]` at recovery**: If you recover and `mission` is `[pending]`, treat the journal as if no mission exists. Set the mission from the user's next substantive request. Do not carry `[pending]` across sessions — it provides no recovery value.

## Mission State

`state` defaults to `"active"`. Update it when the mission is stuck:

- Set `state: "blocked"` when a task fails and you cannot proceed without resolving it, or a test is failing and the root cause is unknown.
- Set `state: "waiting"` when you've asked the user a question or are dependent on an async process (CI, deployment, external API).
- Set `state_reason` to explain why — be specific (`"auth test 401 on valid token"` not `"test failing"`).
- Reset to `state: "active"`, `state_reason: null` when the blocker is resolved.

**Recovery behavior:** If `state` is `"blocked"` or `"waiting"` when you recover from compaction, investigate `state_reason` first before proceeding to `upcoming` tasks. The blocker may still be active.

## In-Progress Tracking

`in_progress` captures a task that started but hasn't completed — the exact scenario where compaction is most damaging.

**Write the journal with `in_progress` set before you begin any task that will not complete in a single tool call.** This includes: multi-step sequences (build + deploy, multi-file refactor), launching an async agent and waiting for output, producing multiple output files, or any work where you know the next 2+ steps. Write immediately — do not wait for the task to finish.
```json
"in_progress": {
  "task": "deploy auth service",
  "started": "2026-05-05T09:00:00Z",
  "progress": "build passed, uploading assets"
}
```

**Update `progress`** after each sub-step to record where you are.

**Clear `in_progress`** (set to `null`) when the task completes — add it to `completed` instead.

**Recovery:** If `in_progress` is set, the first action after compaction recovery is to verify its current state (re-run the relevant test, check if the file exists, check the deploy endpoint), then resume from where `progress` indicates — not from scratch.

**Task abandoned by user**: If the user abandons a task ("never mind", "skip that", "let's do Y instead"), clear `in_progress` (set to null) without adding it to `completed`. Remove the abandoned task from `upcoming` if present. Do not record abandoned tasks as completed — they produced no result.

## Upcoming Tasks

List tasks you know are coming next based on explicit user statements or clear logical dependencies. Maximum 5.

**Each item must name the action plus one concrete anchor** — a file path, command, endpoint, or precondition — so a recovering session can act without re-investigation:

Good: `"deploy auth -> run: wrangler pages deploy dist"`
Good: `"fix test failure in tests/auth.test.js (401 on valid token)"`
Good: `"wait for user to approve pricing model before proceeding"`
Bad: `"push to GitHub"` (which repo? which branch?)
Bad: `"fix the bug"` (which file? which error?)

Update `upcoming` when:
- **You know the plan**: when you begin a sequence of tasks, write all known next steps into `upcoming` before starting the first one. This is the primary compaction defense — if compaction fires mid-sequence, the recovering Claude needs to see what was planned.
- A new task becomes clearly necessary from a completed task's result
- The user mentions what they want to do next
- A planned task is completed (remove it, add it to `completed`)

Do not speculate about future tasks beyond what the user has indicated.

## Rolling Window and Pruning

The journal keeps at most 8 completed entries. When entry 9 would be added:
1. Remove the oldest entry from `completed`
2. Append its essence to `summary`: `summary += ". " + task + " -> " + result`
3. Trim `summary` from the start if it exceeds 300 characters (recent context is more valuable)

The hook handles staleness (entries older than 7 days) automatically at session start.

## Recovery After Compaction

When you see the `[MEMENTO]` header injected into your context after compaction, orient immediately:

1. Check `mission_closed` — if set, the previous mission is finished. Do not execute its `upcoming` tasks. Wait for the user's next request and start a fresh mission.
2. Check `state` — if `"blocked"` or `"waiting"`, read `state_reason` and investigate that first
3. Check `in_progress` — if set, verify its current state before doing anything else (re-run the test, check if the file changed, ping the endpoint)
4. Read `mission` — confirm it matches what the user is asking about
5. Read `completed` — understand what has been done and what it produced
6. Read `upcoming` — these are the planned next tasks

**Verify before acting** on `in_progress` and the first upcoming task:
- Task mentions a file → read it; confirm changes aren't already applied
- Task mentions a deploy → check the live endpoint or deployment logs
- Task mentions a fix → run the relevant test to confirm it still fails
- Task mentions a build → check if build output exists and is recent
- If you cannot determine a verification method, state what you'd check and proceed

**If `in_progress` work is already complete**: move it to `completed` with the result you can observe, set `in_progress` to null, and proceed to the next upcoming task. Do not re-execute completed work.

Do not ask the user "should I continue?" — just verify and go.

The journal is a recovery aid, not an authority. Always verify before action.

If the injected journal describes a different project than what the user is now asking about, treat it as historical context only and start a fresh mission.

## Creating a New Journal

When you see `[MEMENTO] No prior journal | instance:X | proj:Y | path:/some/path`:
1. Wait for the first substantive user request
2. Write the journal file to **the exact path shown in the header** — never derive the path yourself
3. Use the full schema: `state: "active"`, `in_progress: null`, `completed: []`, `upcoming: []`
4. Set `mission` from the first substantive user request
5. Set `project` to the value shown after `proj:` in the header

**Creating the journal is mandatory on first substantive task.** If you skip it, the next session after compaction will have no recovery context.

## Boundaries

Memento owns only the journal file shown in the `[MEMENTO]` header. It does not write to:
- `CLAUDE.md` — permanent project knowledge (different layer)
- `MEMORY.md` — cross-session temporal notes (different layer)
- Conversation — never surface journal content in chat unless asked

Never journal: raw file contents, full command output, secrets, credentials, or anything the user has not explicitly asked to track. Summarize, don't transcribe.

If the user asks "what does memento have on this session?", read the journal file and display it directly.
