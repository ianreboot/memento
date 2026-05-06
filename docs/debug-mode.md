# Debug Mode

Memento includes a shadow debug journal that records every write, prune, injection, and mission lifecycle event without affecting the main journal. This is for post-session forensics — diagnosing why an entry wasn't written, whether a prune was too aggressive, or confirming what was injected at compaction.

## Enabling

Set `MEMENTO_DEBUG=1` in your Claude Code settings:

```json
{
  "env": {
    "MEMENTO_DEBUG": "1"
  }
}
```

Restart Claude Code. The debug journal starts accumulating from the next session.

## Disabling

Remove the `MEMENTO_DEBUG` line from your settings and restart Claude Code. The debug journal for your instance is automatically deleted at the next session start — no manual cleanup needed.

## Debug journal location

```
~/.claude/.memento/<instance-tag>.debug.json
```

For example, if your OS username is `alice`, the debug journal is at:

```
~/.claude/.memento/alice.debug.json
```

The main journal (`alice.json`) is completely unaffected by debug mode.

## Schema reference

The debug journal is a JSON file with these top-level fields:

| Field | Type | What it contains |
|-------|------|-----------------|
| `project` | string | Instance tag (the filename stem, e.g. `alice`) |
| `debug_since` | ISO timestamp | When debug mode was first active for this journal |
| `write_seq` | number | Monotonic counter incremented on every debug write |
| `sessions` | array | One entry per Claude Code session start |
| `lifecycle_events` | array | Mission open, close, and reopen events |
| `injections` | array | What the SessionStart hook injected at each session start |
| `collapse_events` | array | Stale collapse events (all entries folded into summary) |
| `write_failures` | array | Silent-fail events where a journal write was aborted |
| `summary_history` | array | Each time the `summary` field changed |
| `upcoming_mutations` | array | Items added to or removed from `upcoming[]` |
| `entries` | array | Every completed entry ever written — never pruned |

### sessions

One object per session start:

```json
{
  "session_id": "abc123",
  "started_at": "2026-05-05T14:14:44.000Z",
  "source": "compact",
  "ended_at": null
}
```

`source` values: `"startup"` (fresh session), `"compact"` (post-compaction recovery), `"resume"` (resumed session).

### injections

One object per SessionStart hook invocation:

```json
{
  "ts": "2026-05-05T14:14:44.000Z",
  "hook": "memento-activate.js",
  "source": "compact",
  "mode": "full",
  "pruned": false,
  "journal_existed": true,
  "entries_injected": 7,
  "bytes_injected": 892
}
```

`mode` values:
- `"brief"` — one-line summary, used at fresh session start
- `"full"` — complete journal, used after compaction or resume
- `"path_hint"` — no prior journal; Claude was given the path to write to

### entries

All completed entries ever written, annotated with a `_debug` block:

```json
{
  "task": "fix auth middleware",
  "result": "PASETO impl, expiry corrected",
  "ctx": "user: auth is broken before deploy",
  "ts": "2026-05-05T10:00:00.000Z",
  "_debug": {
    "status": "active",
    "written_at": "2026-05-05T10:00:05.123Z",
    "journal_bytes": 1284,
    "write_seq": 3
  }
}
```

`_debug.status` values:

| Status | Meaning |
|--------|---------|
| `"active"` | Entry is in the main journal |
| `"would_roll_summary"` | Entry was folded into `summary` (rolling window) |
| `"would_prune_stale"` | Entry was removed in a stale collapse |

### lifecycle_events

```json
{
  "type": "mission_opened",
  "mission": "ship auth fix + pricing analysis",
  "ts": "2026-05-05T09:00:00.000Z",
  "trigger": "first_write"
}
```

`type` values: `mission_opened`, `mission_closed`, `mission_changed`, `mission_reopened`.

`trigger` values: `first_write` (Claude wrote the journal for the first time), `claude_write` (Claude set `mission_closed`), `hook_clear` (the UserPromptSubmit hook detected `/clear`).

### write_failures

Recorded whenever `writeJournal()` aborts without writing:

```json
{
  "ts": "2026-05-05T11:00:00.000Z",
  "reason": "size_cap_after_prune",
  "journal_bytes": 6291,
  "attempted_entry": { "task": "...", ... }
}
```

`reason` values: `"size_cap_after_prune"` (journal exceeded 6KB even after pruning), `"unexpected_error"`.

## Reading the log

**Confirm injection happened at compaction:**

Look for an `injections` entry with `source: "compact"` and `mode: "full"`. `entries_injected` tells you how many completed entries were in the journal at that moment.

**Check if an entry was written:**

Find it in `entries[]`. If absent, the Write tool call either didn't happen or failed — check `write_failures[]`.

**Understand a prune:**

If an entry has `_debug.status: "would_roll_summary"`, it was folded into `summary` when the rolling window hit 8 entries. Check `summary_history[]` for the summary text at that point.

**Check for stale collapse:**

Look in `collapse_events[]`. A stale collapse fires when the newest completed entry is more than 7 days old — it folds all entries into summary and sets `mission_closed`.

**Verify field limits were respected:**

If an entry's `_debug` block contains `truncated_fields`, one or more fields were over the character limit and were trimmed before writing.

## Size and retention

The debug journal is capped at 2MB. Unlike the main journal, entries are never pruned — everything accumulates for the duration of the debug session.

When debug mode is disabled, the file is deleted automatically at the next session start. If you want to preserve it for analysis, copy it before disabling debug mode:

```bash
cp ~/.claude/.memento/alice.debug.json ~/memento-debug-$(date +%Y%m%d).json
```
