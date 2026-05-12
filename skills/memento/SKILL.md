---
name: memento
description: >
  Persistent task memory across context compaction. Maintains a rolling journal of
  completed tasks, their results, and causal context so Claude can recover mid-task
  after compaction without human intervention. Hook injection is automatic and invisible.
  Journal writes require Claude to use the Write tool after each task — no slash command needed.
---

# Memento

Maintain a lightweight, mission-scoped journal that survives context compaction.
The journal is a small JSON file on disk. Claude writes it. Hooks read and inject it.

**Purpose**: Memento preserves the *why* behind work — your goals, constraints, and reasoning chains — so Claude can make correct decisions after context loss, not just resume the right task.

## When to Write

Write the journal when information changes that compaction would destroy:

1. **Mission opens** — capture mission (request + constraints + done-when) immediately
2. **A result changes the decision landscape** — add a `done` entry with `ctx: note: X means we should Y`
3. **User pivots or adds constraints** — update the `mission` field
4. **Multi-step task begins** — set `wip` before the first tool call
5. **Mission closes** — set `mission_closed`

~3-7 writes per session. Do not write after every minor step — write when information that compaction would destroy has changed.

## Architecture

Understanding who does what prevents confusion:

| Component | Role |
|-----------|------|
| **This SKILL.md** | Instructs Claude when and how to write journal entries |
| **`memento-activate.js`** (SessionStart hook) | Reads journal, injects it as system context |
| **`memento-tracker.js`** (UserPromptSubmit hook) | Detects mission-close events, emits reminder |
| **Claude (you)** | Writes journal entries via the Write tool |

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

When switching projects, also open a new mission (new `mission_opened`, clear `mission_closed`, reset `done`/`plan`). Keep `summary` as historical context if relevant.

If the header shows `proj:default`, update the `project` field to the name of the first directory or repository you work in. `default` provides no recovery orientation.

## Journal Schema

```json
{
  "mission":        "user's request + constraints + done-when (max 400 chars — verbatim, not rewritten)",
  "mission_opened": "ISO 8601 timestamp",
  "mission_closed": "ISO 8601 timestamp or null",
  "project":        "string — project tag (from hook header)",
  "summary":        "string or null — rolling summary of pruned entries (max 300 chars)",
  "wip":            "string or null — mid-task state or blocker (max 150 chars)",
  "done": [
    {
      "act":    "string — what was done (max 80 chars)",
      "result": "string — what it produced (max 120 chars)",
      "ctx":    "string — typed context: user:... | tool:... | note:... (max 120 chars, omit if none)",
      "ts":     "ISO 8601 timestamp"
    }
  ],
  "plan": ["next step with causal anchor (max 150 chars)", "..."]
}
```

**Field limits are hard constraints** — truncate before writing. The journal file must stay under 6KB. If it would exceed 6KB after an update, prune `done` first (fold oldest into `summary`), then write.

## Mission Field

The `mission` field is the most important field in the journal. It is the anchor that a recovering Claude uses to orient itself after compaction.

**Capture the user's request close to verbatim**, plus governing constraints and definition of done.

Format: `"[user's request] -- [constraints] -- done when: [success criteria]"`

Example:
```
"fix auth pipeline -- don't change token format, deploy to staging only -- done when: all tests pass + staging health check green"
```

**Do NOT rewrite into a deliverable statement.** Preserve the user's words and urgency.
**Do NOT summarize away constraints.** "user: don't change token format" is behavioral context a recovering Claude must have.

Good:
- `"memento v0.2.0 redesign: intent-anchor reframe -- user: new branch v0.2.0-intent-redesign, collapsed mission+intent field, event-driven writes -- done when: all files updated + tests pass + pushed"`
- `"decide pricing model for Q3 launch -- external docs only, no internal estimates -- done when: user picks model"`

Bad:
- `"help user with auth"` (vague, no deliverable)
- `"implement feature X"` (rewritten into deliverable — lost the user's constraints)

**Mission lifecycle:**
- Open: set `mission_opened` to current timestamp, `mission_closed` to null
- Close: the UserPromptSubmit hook sets `mission_closed` when it detects `/clear` or explicit project-shift commands. You do not need to handle these.
- **Claude-driven closure:** If you complete the last plan item and the user confirms satisfaction ("that's done", "ship it", "looks good"), set `mission_closed` to the current timestamp and `plan` to `[]`. Do not wait for the hook — a closed mission is a clear signal to the next session that this work is finished.
- New mission: when `mission_closed` is set and the user starts working on something new, write a new journal with `mission_opened` reset and `mission_closed` null. Preserve old `summary` as historical context if relevant.

**`[pending]` at recovery**: If you recover and `mission` is `[pending]`, treat the journal as if no mission exists. Set the mission from the user's next substantive request. Do not carry `[pending]` across sessions — it provides no recovery value.

## Done Entries — The Fidelity Rule

**Compress format, not facts.**

Every field must reflect only what was directly stated by the user or observed in tool output. Never infer, assume, or fabricate entry content.

| Field | What to write | What NOT to write |
|-------|---------------|-------------------|
| `act` | Short name of the completed action | Inferred intent or assumed purpose |
| `result` | Actual output: numbers, file paths, status codes, key findings | Your narrative interpretation of the result |
| `ctx` | One of three typed forms (see below) | Unprefixed narrative or invented quotes |

### ctx typed prefixes

The `ctx` field accepts exactly three forms — always use the prefix so a recovering Claude knows what kind of information it is:

- `user: <exact words>` — user's triggering statement
- `tool: <output snippet>` — tool output that caused this task
- `note: <forward causation>` — a result means we should... (e.g., "note: margin loss on SKU-47 means Q3 launch must hold until pricing revised")

If none of these applies, **omit `ctx` entirely**. An absent ctx is honest. A fabricated one misleads the next Claude instance.

**The `note:` prefix is for causal linkage** — use it when a result changes what should happen next:

```json
{
  "act": "run pricing analysis",
  "result": "margins negative on SKU-47, 3 gaps found",
  "ctx": "note: margin loss on SKU-47 means Q3 launch must hold until pricing model revised",
  "ts": "2026-05-05T08:15:00Z"
}
```

**Good entries:**
```json
{ "act": "fix auth middleware", "result": "PASETO impl, token expiry corrected", "ctx": "user: auth is broken before deploy", "ts": "..." }
```
```json
{ "act": "analyze pricing model", "result": "3 gaps found, margins off 12%", "ctx": "tool: pricing_check.py showed negative margin on SKU-47", "ts": "..." }
```
```json
{ "act": "deploy auth service (attempt 2)", "result": "deployed to staging, health check passed", "ctx": "note: first attempt failed mid-upload; resumed from upload step", "ts": "..." }
```

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

**Discussion and research sessions** work the same as any other session — they have a mission, causal linkage, and done entries. A brand-naming research session: `mission = "find brand name for us-seo -- .com+.net free, non-generic, home-services adjacent, no IQ suffix -- done when: user picks name"`, done entries with `ctx: note:` for eliminated directions, `wip` for current candidate state. No special casing needed.

## Entry Compression

Keep entries terse. Omit articles (a/an/the) and filler words. Abbreviate common terms (`auth`, `db`, `cfg`, `impl`, `env`, etc.). Preserve numbers, file paths, function names, and error strings exactly.

Priority: factual completeness over grammatical correctness. `"fix auth middleware PASETO expiry"` is better than `"Fixed the authentication middleware's PASETO token expiry handling."`

## WIP Tracking

`wip` captures a task that started but hasn't completed — the exact scenario where compaction is most damaging.

**Write the journal with `wip` set before you begin any task that will not complete in a single tool call.** This includes: multi-step sequences (build + deploy, multi-file refactor), launching an async agent and waiting for output, producing multiple output files, or any work where you know the next 2+ steps.

```json
"wip": "deploy auth service — build passed, uploading assets"
```

Also use `wip` for blockers: `"blocked: auth test 401 on valid token — root cause unknown"`

**Clear `wip`** (set to `null`) when the task completes — add it to `done` instead.

**Recovery:** If `wip` is set, the first action after compaction recovery is to verify its current state (re-run the relevant test, check if the file exists, check the deploy endpoint), then resume from where `wip` indicates — not from scratch.

**Task abandoned by user**: If the user abandons a task ("never mind", "skip that", "let's do Y instead"), clear `wip` (set to null) without adding it to `done`. Remove the abandoned task from `plan` if present. Do not record abandoned tasks as completed — they produced no result.

## Plan Items

List tasks you know are coming next based on explicit user statements or clear logical dependencies. Maximum 3.

**Each item must name the action plus one concrete anchor** — a file path, command, endpoint, or precondition — so a recovering session can act without re-investigation:

Good: `"deploy auth -> run: wrangler pages deploy dist"`
Good: `"fix test failure in tests/auth.test.js (401 on valid token)"`
Good: `"wait for user to approve pricing model before proceeding"`
Bad: `"push to GitHub"` (which repo? which branch?)
Bad: `"fix the bug"` (which file? which error?)

Update `plan` when:
- **You know the sequence**: when you begin a series of tasks, write all known next steps into `plan` before starting the first one. This is the primary compaction defense — if compaction fires mid-sequence, the recovering Claude needs to see what was planned.
- A new task becomes clearly necessary from a completed task's result
- The user mentions what they want to do next
- A planned task is completed (remove it from `plan`, add it to `done`)

Do not speculate about future tasks beyond what the user has indicated. Keep `plan` to 3 items max.

## Rolling Window and Pruning

The journal keeps at most 6 completed entries (configurable via `MEMENTO_MAX_ENTRIES`, range 4–24). When the limit is exceeded:
1. Remove the oldest entry from `done`
2. Append its essence (including ctx) to `summary`
3. Trim `summary` from the start if it exceeds 300 characters (recent context is more valuable)

The hook handles staleness automatically at session start using a two-tier model: closed missions collapse after 7 days; active missions after 14 days. The extended threshold for active missions protects journals from users who take extended breaks without explicitly closing their mission first.

## Recovery After Compaction

When you see the `[MEMENTO]` header injected into your context after compaction, orient immediately:

1. Check `mission_closed` — if set, the previous mission is finished. Do not execute its `plan` items. Wait for the user's next request and start a fresh mission.
2. Check `wip` — if set, verify its current state before doing anything else (re-run the test, check if the file changed, ping the endpoint)
3. Read `mission` — confirm it matches what the user is asking about
4. Read `done` — understand what has been done and what it produced
5. Read `plan` — these are the planned next tasks

**Verify before acting** on `wip` and the first plan item:
- Task mentions a file → read it; confirm changes aren't already applied
- Task mentions a deploy → check the live endpoint or deployment logs
- Task mentions a fix → run the relevant test to confirm it still fails
- Task mentions a build → check if build output exists and is recent
- If you cannot determine a verification method, state what you'd check and proceed

**If `wip` work is already complete**: move it to `done` with the result you can observe, set `wip` to null, and proceed to the next plan item. Do not re-execute completed work.

**Journal the verification**: When you verify `wip` tasks after recovery, write the result as a done entry — `{ "act": "verify: <task>", "result": "<what you found>", "ctx": "note: verified after compaction recovery", "ts": "<now>" }`. This creates a paper trail for the next compaction.

**If WORK_STATE.md or a detailed compaction summary is also present**: treat it as authoritative for task specifics. The memento journal provides mission framing and task history; WORK_STATE provides granular recovery detail. Use both. Write journal updates to the path shown in the `[MEMENTO]` header.

Do not ask the user "should I continue?" — just verify and go.

The journal is a recovery aid, not an authority. Always verify before action.

If the injected journal describes a different project than what the user is now asking about, treat it as historical context only and start a fresh mission.

## Creating a New Journal

When you see `[MEMENTO] No prior journal | instance:X | proj:Y | path:/some/path`:
1. Write the journal file to **the exact path shown in the header** — never derive the path yourself
2. Set `mission` from the user's first substantive request; use `"[pending]"` if unclear and update when clear
3. Set `project` to the value shown after `proj:` in the header

**Minimal write template** (the hook fills defaults for omitted fields):
```json
{
  "mission": "<from user's request, or '[pending]'>",
  "mission_opened": "<ISO timestamp>",
  "mission_closed": null,
  "project": "<proj: value from header>",
  "wip": null,
  "done": [],
  "plan": []
}
```

**Post-compaction recovery with no prior journal**: If you see `[MEMENTO] No prior journal` alongside a compaction summary or WORK_STATE context, create the journal **immediately** — infer the mission from the available context before executing any task. Do not wait for a new user request; the session is already in motion.

**Creating the journal is mandatory on first substantive task.** If you skip it, the next session after compaction will have no recovery context.

## Boundaries

Memento owns only the journal file shown in the `[MEMENTO]` header. It does not write to:
- `CLAUDE.md` — permanent project knowledge (different layer)
- `MEMORY.md` — cross-session temporal notes (different layer)
- Conversation — never surface journal content in chat unless asked

Never journal: raw file contents, full command output, secrets, credentials, or anything the user has not explicitly asked to track. Summarize, don't transcribe.

If the user asks "what does memento have on this session?", read the journal file and display it directly.
