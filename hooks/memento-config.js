#!/usr/bin/env node
// memento — shared configuration and journal utilities
//
// This module is required by all memento hook scripts. It handles:
//   - Instance tag derivation (which journal file to use; one file per OS user)
//   - Project tag derivation (informational; tracks current project in journal.project)
//   - Journal file path resolution
//   - Safe atomic reads and writes (symlink-safe, size-capped)
//   - Journal formatting for context injection
//   - Journal pruning (rolling window, staleness, size cap)
//
// Debug shadow journal (MEMENTO_DEBUG=1) lives in memento-debug.js,
// loaded lazily below. All debug I/O is isolated there.
//
// Design principles:
//   - Silent-fail on all filesystem errors — never block Claude Code
//   - Atomic writes via temp-file + rename — no mid-write corruption on crash
//   - Symlink-safe I/O — see security note below
//   - No external dependencies — only Node.js built-ins
//
// Security note on symlink safety:
//   The journal file lives at a predictable path. Without protection, a local
//   attacker could replace it with a symlink to a sensitive file. If the hook
//   then reads or writes through the symlink, it either injects sensitive content
//   into Claude's context (read) or clobbers an unintended file (write). We
//   defend against this by checking lstat() before every open, refusing
//   symlinks at both the file and parent-directory level (with the exception of
//   trusted symlinked ~/.claude dirs — see writeJournal comments).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Maximum journal file size. A fully-populated journal at max field lengths:
//   mission:200 + summary:300 + 8×(task:80+result:120+ctx:120+ts:24) + 5×upcoming:100
//   ≈ 4300 bytes + JSON formatting overhead. 6KB provides safe headroom.
// Files exceeding this are treated as corrupt and replaced with a fresh journal.
const MAX_JOURNAL_BYTES = parseInt(process.env.MEMENTO_MAX_FILE_KB || '', 10) * 1024 || 6 * 1024;

// Rolling window: keep at most this many completed entries before summarizing.
// At ~25 tokens/entry in injection format, 8 entries ≈ 200 tokens — negligible
// against a 200k context window.
const MAX_COMPLETED = 8;

// Maximum upcoming tasks to track. Claude rarely plans more than 5 concrete steps.
const MAX_UPCOMING = 5;

// Summary field max length in characters. 300 chars fits ~4-5 folded entries,
// providing meaningful historical breadth at negligible token cost (~75 tokens).
const MAX_SUMMARY_CHARS = 300;

// How old (in days) the newest completed entry can be before the journal is
// considered stale. Stale journals are collapsed to summary on SessionStart.
const STALE_DAYS = parseInt(process.env.MEMENTO_STALE_DAYS || '', 10) || 7;

// Character limits enforced on individual entry fields before writing.
const FIELD_LIMITS = { task: 80, result: 120, ctx: 120, mission: 200 };

// Working directory names that provide no useful project identity. When the
// cwd basename matches one of these, fall through to the next tag source.
const TAG_BLOCKLIST = new Set([
  'workspace', 'tmp', 'temp', 'home', 'root', 'user', 'ubuntu',
  'claude', 'projects', '', '/', '.',
]);

// Debug mode: when MEMENTO_DEBUG=1, a shadow journal (<instance>.debug.json)
// is written alongside the main journal. It accumulates all entries without
// pruning and annotates what would have been pruned, for post-session forensics.
// The normal journal is completely unaffected. Debug mode never breaks the session.
const DEBUG = process.env.MEMENTO_DEBUG === '1';

// Load debug utilities only when debug mode is active — avoids requiring the
// module (and its fs/path overhead) on every hook invocation.
const debugModule = DEBUG ? (() => { try { return require('./memento-debug'); } catch (e) { return null; } })() : null;

// ---------------------------------------------------------------------------
// Instance tag derivation (used for journal FILE PATH)
// ---------------------------------------------------------------------------

// Derive the instance tag used as the journal filename stem.
//
// Per-instance design: one journal per Claude docker container, regardless of
// which project is currently being worked on. This avoids path-mismatch bugs
// where the hook and Claude independently derive different project tags and
// write to / read from different files.
//
// Resolution order:
//   1. MEMENTO_INSTANCE_TAG env var — explicit override (for multi-window setups)
//   2. OS username (os.userInfo().username) → "alice", "ubuntu", etc.
//   3. "default" — fallback
//
// The journal's `project` field (written by Claude) still tracks the current
// project being worked on — this is for human-readable context, not routing.
function getInstanceTag() {
  // 1. Explicit instance override (for multi-window single-user setups)
  const envTag = process.env.MEMENTO_INSTANCE_TAG;
  if (envTag) {
    const normalized = normalize(envTag);
    if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
  }

  // 2. OS username
  try {
    const username = os.userInfo().username;
    if (username) {
      const normalized = normalize(username);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* fall through */ }

  // 3. Default
  return 'default';
}

// getProjectTag is kept for informational use (journal `project` field context).
// It is NOT used for file path routing — use getInstanceTag() for that.
function getProjectTag() {
  // 1. Git repo root basename
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    const name = path.basename(gitRoot);
    if (name) {
      const normalized = normalize(name);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* not in a git repo */ }

  // 2. CWD basename
  try {
    const cwdName = path.basename(process.cwd());
    if (cwdName) {
      const normalized = normalize(cwdName);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* fall through */ }

  return 'default';
}

function normalize(tag) {
  const result = tag.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  return result || 'default';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Returns the path to the ~/.claude directory (or $CLAUDE_CONFIG_DIR).
function getClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Returns the path to the journal file for a given instance tag.
// Creates the .memento directory if needed (silent-fail).
function getJournalPath(claudeDir, instanceTag) {
  const dir = path.join(claudeDir, '.memento');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* silent */ }
  return path.join(dir, `${instanceTag}.json`);
}

// ---------------------------------------------------------------------------
// Safe journal read
// ---------------------------------------------------------------------------

// Read and parse the journal file.
// Returns the parsed object, or null if the file is missing, too large,
// a symlink, or contains invalid JSON.
//
// Size cap prevents two attacks:
//   a) Injecting a huge file into Claude's context
//   b) CPU exhaustion from parsing a crafted JSON payload
function readJournal(journalPath) {
  try {
    let st;
    try {
      st = fs.lstatSync(journalPath);
    } catch (e) {
      return null; // File doesn't exist — normal on first run
    }

    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > MAX_JOURNAL_BYTES) return null;

    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW : 0;
    let fd;
    let raw;
    try {
      fd = fs.openSync(journalPath, fs.constants.O_RDONLY | O_NOFOLLOW);
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* silent */ }
    }

    const journal = JSON.parse(raw);

    // Basic schema validation — must have at minimum a mission string
    if (typeof journal !== 'object' || journal === null) return null;
    if (typeof journal.mission !== 'string') return null;
    if (journal.completed !== undefined && !Array.isArray(journal.completed)) return null;
    if (journal.upcoming !== undefined && !Array.isArray(journal.upcoming)) return null;

    return journal;
  } catch (e) {
    return null; // Corrupt or unreadable — start fresh
  }
}

// ---------------------------------------------------------------------------
// Safe journal write (atomic, symlink-safe)
// ---------------------------------------------------------------------------

// Write the journal object atomically.
//
// Steps:
//   1. Serialize to JSON
//   2. Write to a temp file with a unique name (pid + timestamp)
//   3. Set permissions to 0600 (owner read/write only)
//   4. rename() temp → target (atomic on POSIX; best-effort on Windows)
//
// Symlink safety: refuses to write if the target path or its parent directory
// is a symlink pointing to a location owned by a different user.
//
// If MEMENTO_DEBUG=1: reads old journal before writing, then after a successful
// write logs new entries, field truncations, upcoming mutations, and mission
// lifecycle changes to the shadow debug journal. Also logs write failures.
//
// Silent-fails on any filesystem error.
function writeJournal(journalPath, data) {
  const debugLogging = process.env.MEMENTO_DEBUG === '1';
  let tempPath;
  const now = new Date().toISOString();
  const debugEvents = [];

  try {
    const journalDir  = path.dirname(journalPath);
    const journalBase = path.basename(journalPath);

    fs.mkdirSync(journalDir, { recursive: true });

    // Resolve parent directory — allow legitimate symlinked ~/.claude dirs
    // but refuse attacker-planted symlinks pointing at dirs owned by another user
    let realDir;
    try {
      const lstat = fs.lstatSync(journalDir);
      if (lstat.isSymbolicLink()) {
        realDir = fs.realpathSync(journalDir);
        const realStat = fs.statSync(realDir);
        if (!realStat.isDirectory()) {
          if (debugLogging) process.stderr.write(`[memento] writeJournal: symlink target ${realDir} is not a directory\n`);
          return;
        }
        // On Unix, verify ownership. On Windows, verify it's under the home dir.
        if (typeof process.getuid === 'function') {
          if (realStat.uid !== process.getuid()) {
            if (debugLogging) process.stderr.write(`[memento] writeJournal: symlink target owned by uid ${realStat.uid}, not current user\n`);
            return;
          }
        } else {
          const normalizedReal = path.resolve(realDir).toLowerCase();
          const normalizedHome = path.resolve(os.homedir()).toLowerCase();
          if (!normalizedReal.startsWith(normalizedHome + path.sep) && normalizedReal !== normalizedHome) {
            if (debugLogging) process.stderr.write(`[memento] writeJournal: symlink target ${realDir} is outside home directory\n`);
            return;
          }
        }
      } else {
        realDir = journalDir;
      }
    } catch (e) {
      return;
    }

    // The journal file itself must not be a symlink (the actual clobber vector)
    const realJournalPath = path.join(realDir, journalBase);
    try {
      if (fs.lstatSync(realJournalPath).isSymbolicLink()) {
        if (debugLogging) process.stderr.write(`[memento] writeJournal: journal file is a symlink — refusing to write\n`);
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') return; // Unexpected error — abort
    }

    // Read old journal for debug comparison (before any modification)
    const oldJournal = debugLogging ? readJournal(journalPath) : null;

    // Detect field truncations before applying limits
    const truncations = debugLogging && debugModule ? debugModule.detectTruncations(data) : null;

    // Truncate fields to their max lengths before serializing
    const safe = applyFieldLimits(data);
    let json = JSON.stringify(safe, null, 2);
    let journalBytes = Buffer.byteLength(json, 'utf8');

    // If serialized size exceeds cap, prune and retry once
    if (journalBytes > MAX_JOURNAL_BYTES) {
      if (debugLogging) process.stderr.write(`[memento] writeJournal: journal exceeds ${MAX_JOURNAL_BYTES} bytes, pruning\n`);

      const pruneResult = debugLogging
        ? pruneJournal(safe, { debug: true })
        : pruneJournal(safe);
      const pruned = debugLogging ? pruneResult.journal : pruneResult;

      if (debugLogging && pruneResult.debugEvents) {
        debugEvents.push(...pruneResult.debugEvents);
      }

      const prunedJson = JSON.stringify(pruned, null, 2);
      const prunedBytes = Buffer.byteLength(prunedJson, 'utf8');

      if (prunedBytes > MAX_JOURNAL_BYTES) {
        // Still too large after pruning — abort silently
        if (debugLogging && debugModule) {
          debugEvents.push({
            type: 'write_failure',
            data: {
              ts:              now,
              reason:          'size_cap_after_prune',
              journal_bytes:   prunedBytes,
              attempted_entry: Array.isArray(data.completed) && data.completed.length > 0
                ? data.completed[data.completed.length - 1]
                : null,
            },
          });
          debugModule.appendDebugEvents(journalPath, debugEvents);
        }
        return;
      }

      json = prunedJson;
      journalBytes = prunedBytes;
    }

    // Atomic write: temp file → rename
    tempPath = path.join(realDir, `.memento-${path.basename(journalBase, '.json')}.${process.pid}.${Date.now()}.tmp`);
    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const openFlags  = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(tempPath, openFlags, 0o600);
      fs.writeSync(fd, json);
      try { fs.fchmodSync(fd, 0o600); } catch (e) { /* best-effort on Windows */ }
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* silent */ }
    }
    fs.renameSync(tempPath, realJournalPath);

    // Successful write — collect and flush debug events
    if (debugLogging && debugModule) {
      // New entries Claude just added
      const newEntries = debugModule.findNewEntries(oldJournal, safe);
      for (const entry of newEntries) {
        const trunc = truncations && entry.ts ? truncations[entry.ts] : null;
        debugEvents.push({
          type: 'entry_written',
          data: {
            ...entry,
            _debug: Object.assign(
              { status: 'active', written_at: now, journal_bytes: journalBytes },
              trunc || {}
            ),
          },
        });
      }

      // Upcoming array mutations
      debugEvents.push(...debugModule.diffUpcoming(oldJournal, safe, now));

      // Mission lifecycle changes
      debugEvents.push(...debugModule.detectMissionLifecycle(oldJournal, safe, now));

      if (debugEvents.length > 0) {
        debugModule.appendDebugEvents(journalPath, debugEvents);
      }
    }

  } catch (e) {
    // Clean up temp file to prevent accumulation of orphaned files
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }

    if (debugLogging && debugModule) {
      debugEvents.push({
        type: 'write_failure',
        data: { ts: now, reason: 'unexpected_error', journal_bytes: 0, error: e.message },
      });
      try { debugModule.appendDebugEvents(journalPath, debugEvents); } catch (_) {}
      process.stderr.write(`[memento] writeJournal error: ${e.message}\n`);
    }
    // Silent fail — journal is best-effort
  }
}

function applyFieldLimits(journal) {
  const j = Object.assign({}, journal);
  if (typeof j.mission === 'string') {
    j.mission = j.mission.slice(0, FIELD_LIMITS.mission);
  }
  if (Array.isArray(j.completed)) {
    j.completed = j.completed.filter(Boolean).map(entry => ({
      ...entry,
      task:   typeof entry.task   === 'string' ? entry.task.slice(0, FIELD_LIMITS.task)   : '',
      result: typeof entry.result === 'string' ? entry.result.slice(0, FIELD_LIMITS.result) : '',
      // C1: preserve absent ctx as absent — SKILL.md says "omit the field entirely" when unknown.
      // Coercing undefined→'' makes absent indistinguishable from empty, losing that signal.
      ...(typeof entry.ctx === 'string' ? { ctx: entry.ctx.slice(0, FIELD_LIMITS.ctx) } : {}),
    }));
  }
  if (typeof j.summary === 'string') {
    j.summary = j.summary.slice(0, MAX_SUMMARY_CHARS);
  }
  if (Array.isArray(j.upcoming)) {
    j.upcoming = j.upcoming.filter(Boolean).slice(0, MAX_UPCOMING).map(t => String(t).slice(0, 150));
  }
  // D3: normalize state
  if (j.state !== undefined) {
    j.state = ['active', 'blocked', 'waiting'].includes(j.state) ? j.state : 'active';
  }
  if (typeof j.state_reason === 'string') {
    j.state_reason = j.state_reason.slice(0, 120);
  } else if (j.state_reason !== null && j.state_reason !== undefined) {
    j.state_reason = null;
  }
  // D1: normalize in_progress
  if (j.in_progress !== null && j.in_progress !== undefined && typeof j.in_progress === 'object') {
    j.in_progress = {
      task:     typeof j.in_progress.task     === 'string' ? j.in_progress.task.slice(0, 80)     : '',
      started:  typeof j.in_progress.started  === 'string' ? j.in_progress.started                : new Date().toISOString(),
      progress: typeof j.in_progress.progress === 'string' ? j.in_progress.progress.slice(0, 120) : '',
    };
  } else if (j.in_progress !== null) {
    j.in_progress = null;
  }
  return j;
}

// ---------------------------------------------------------------------------
// Journal pruning
// ---------------------------------------------------------------------------

// Prune the journal to fit within rolling window constraints.
//
// Rules (applied in order):
//   1. If completed.length > MAX_COMPLETED (8): fold oldest entry into summary
//   2. If summary > MAX_SUMMARY_CHARS: trim from the start (keep recent context)
//   3. Check staleness: if newest entry is > STALE_DAYS old, collapse all
//      completed entries into summary and clear the array (cross-session reset)
//
// opts.debug: if true, returns { journal, debugEvents } instead of just the journal.
// When opts is omitted, behaves exactly as before — backward-compatible.
function pruneJournal(journal, opts) {
  const dbg = opts && opts.debug;
  if (!journal) return dbg ? { journal, debugEvents: [] } : journal;

  const now = new Date().toISOString();
  const debugEvents = [];

  const j = JSON.parse(JSON.stringify(journal)); // deep copy

  // Filter null entries from arrays
  const completed = (Array.isArray(j.completed) ? j.completed : []).filter(Boolean);
  j.completed = completed;

  // 1. Staleness check — if the newest entry is too old, collapse everything
  if (completed.length > 0) {
    const timestamps = completed.map(e => e && e.ts ? new Date(e.ts).getTime() : 0).filter(t => t > 0);
    const newestTs = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
    if (newestTs && !isNaN(newestTs)) {
      const ageDays = (Date.now() - newestTs.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_DAYS) {
        // Capture debug events before mutating j
        if (dbg) {
          const upcomingCleared = Array.isArray(j.upcoming) ? j.upcoming.filter(Boolean).length : 0;
          const batchSummary = summarizeEntries(completed);
          const summaryAfter = merge(j.summary, `[stale] ${batchSummary}`);
          debugEvents.push({
            type: 'collapse',
            data: {
              ts:                    now,
              type:                  'stale_collapse',
              entries_collapsed:     completed.length,
              upcoming_cleared:      upcomingCleared,
              newest_entry_age_days: Math.round(ageDays * 10) / 10,
              summary_before:        j.summary,
              summary_after:         summaryAfter,
            },
          });
          // Mark each entry as stale in the debug file
          for (const entry of completed) {
            debugEvents.push({
              type:       'entry_status_update',
              ts:         entry.ts,
              task:       entry.task,
              new_status: 'would_prune_stale',
              pruned_at:  now,
            });
          }
          // Upcoming items cleared by the collapse
          if (Array.isArray(j.upcoming)) {
            for (const task of j.upcoming.filter(Boolean)) {
              debugEvents.push({
                type: 'upcoming_mutation',
                data: { ts: now, type: 'cleared', task, trigger: 'stale_collapse' },
              });
            }
          }
        }

        // Collapse all completed into a one-line summary, reset the array.
        // B3: set mission_closed so recovering Claude doesn't see a ghost-active mission.
        const batchSummary = summarizeEntries(completed);
        j.summary = merge(j.summary, `[stale] ${batchSummary}`);
        j.completed = [];
        j.upcoming = [];
        j.in_progress = null;
        if (!j.mission_closed) j.mission_closed = now;
        return dbg ? { journal: j, debugEvents } : j;
      }
    }
  }

  // 2. Rolling window: fold oldest entries into summary until we're within cap
  while (j.completed && j.completed.length > MAX_COMPLETED) {
    const oldest = j.completed.shift();
    if (!oldest) continue;

    const summaryBefore = j.summary;
    const line          = entryToSummaryLine(oldest);
    const summaryAfter  = merge(summaryBefore, line);

    if (dbg) {
      // chars_trimmed_from_start: how many characters were cut when summary exceeded cap
      const joined       = [summaryBefore, line].filter(Boolean).join('. ');
      const charsTrimmed = Math.max(0, joined.length - summaryAfter.length);
      debugEvents.push({
        type:               'entry_rolled',
        entry:              oldest,
        summary_text_added: line,
        rolled_at:          now,
      });
      debugEvents.push({
        type: 'summary_history',
        data: {
          ts:                      now,
          reason:                  'rolling_window',
          entry_ts:                oldest.ts,
          summary_before:          summaryBefore,
          summary_after:           summaryAfter,
          chars_trimmed_from_start: charsTrimmed,
        },
      });
    }

    j.summary = summaryAfter;
  }

  // 3. Cap upcoming array
  if (Array.isArray(j.upcoming)) {
    j.upcoming = j.upcoming.filter(Boolean).slice(0, MAX_UPCOMING);
  }

  return dbg ? { journal: j, debugEvents } : j;
}

// Fold a completed entry into a brief summary line.
function entryToSummaryLine(entry) {
  if (!entry) return '';
  const parts = [entry.task || ''];
  if (entry.result) parts.push(`-> ${entry.result}`);
  return parts.join(' ');
}

// Summarize a batch of entries into one line (used for stale collapse).
function summarizeEntries(entries) {
  return entries.filter(Boolean).map(e => e.task || '').join(', ');
}

// Merge a new line into the summary string, trimming from the start if over cap.
function merge(existing, newLine) {
  const joined = [existing, newLine].filter(Boolean).join('. ');
  if (joined.length <= MAX_SUMMARY_CHARS) return joined;
  // Trim from the start — recent entries are more valuable
  const trimmed = joined.slice(joined.length - MAX_SUMMARY_CHARS);
  // Don't start mid-word — advance to next word boundary
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx > 0 && spaceIdx < 30 ? trimmed.slice(spaceIdx + 1) : trimmed;
}

// ---------------------------------------------------------------------------
// Journal formatting for context injection
// ---------------------------------------------------------------------------

// Convert a journal object to plain text for injection into Claude's context.
//
// Two modes:
//   'full'  — complete journal (used after compaction/resume)
//   'brief' — one-line summary only (used at fresh session start to save tokens)
//
// Format is deliberately terse to minimize token cost.
// Symbols: Done: (completed), Next: (upcoming), Sum: (rolling summary)
// Fields: task -> result | ctx: <user quote or tool fact>
//
// The journal path is included in the header so Claude knows where to write
// updates via the Write tool — this is the ONLY way Claude knows the path.
function formatJournalForInjection(journal, mode, journalPath) {
  if (!journal) return '';

  // Defensive limits — cap what gets injected regardless of what's on disk
  const mission = (journal.mission || '[no mission set]').slice(0, FIELD_LIMITS.mission);
  const project = journal.project || 'default';
  const pathHint = journalPath ? ` | path:${journalPath}` : '';

  const closedMark = journal.mission_closed ? ' (CLOSED)' : '';
  const state      = journal.state || 'active';
  const stateMark  = (state !== 'active' && !journal.mission_closed)
    ? ` [${state.toUpperCase()}${journal.state_reason ? ': ' + journal.state_reason : ''}]`
    : '';

  if (mode === 'brief') {
    const completed = (Array.isArray(journal.completed) ? journal.completed : []).filter(Boolean);
    const upcoming  = (Array.isArray(journal.upcoming)  ? journal.upcoming  : []).filter(Boolean);
    return `[MEMENTO] Mission: ${mission}${closedMark}${stateMark} | proj:${project}${pathHint}\n` +
           `${completed.length} task(s) done, ${upcoming.length} pending. Update journal via Write tool after task completion.`;
  }

  // Full injection (post-compaction recovery)
  const lines = [];
  lines.push(`[MEMENTO] Mission: ${mission}${closedMark}${stateMark} | proj:${project}${pathHint}`);

  if (journal.summary) {
    lines.push(`Sum: ${String(journal.summary).slice(0, MAX_SUMMARY_CHARS)}`);
  }

  const completed = (Array.isArray(journal.completed) ? journal.completed : []).slice(0, MAX_COMPLETED).filter(Boolean);
  for (const entry of completed) {
    const task   = (typeof entry.task   === 'string' ? entry.task   : '').slice(0, FIELD_LIMITS.task);
    const result = (typeof entry.result === 'string' ? entry.result : '').slice(0, FIELD_LIMITS.result);
    const ctx    = (typeof entry.ctx    === 'string' ? entry.ctx    : '').slice(0, FIELD_LIMITS.ctx);
    let line = `Done: ${task}`;
    if (result) line += ` -> ${result}`;
    if (ctx)    line += ` | ctx: ${ctx}`;
    lines.push(line);
  }

  // D1: show in-progress task between Done entries and Next entries
  if (journal.in_progress && journal.in_progress.task) {
    const wip = journal.in_progress;
    let wipLine = `WIP: ${String(wip.task).slice(0, 80)}`;
    if (wip.progress) wipLine += ` | ${String(wip.progress).slice(0, 120)}`;
    lines.push(wipLine);
  }

  const upcoming = (Array.isArray(journal.upcoming) ? journal.upcoming : []).slice(0, MAX_UPCOMING).filter(Boolean);
  if (upcoming.length > 0) {
    lines.push(`Next: ${upcoming.map(t => String(t).slice(0, 150)).join(' | ')}`);
  }

  lines.push('');
  lines.push(
    'Update journal after each task: write JSON to the path above using the Write tool. ' +
    'Write upcoming[] before starting a sequence; set in_progress before any task that spans multiple tool calls or launches an async agent. ' +
    'Entries must reflect only what was stated by the user or observed in tool output — never infer or fabricate.'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Debug journal cleanup
// ---------------------------------------------------------------------------

// Delete the debug journal file for the given journal path, if it exists.
// Called by memento-activate.js at session start when MEMENTO_DEBUG is not set.
// This ensures the debug file is removed on the first session start after debug
// mode is turned off, rather than accumulating stale data indefinitely.
// Silent-fails on any filesystem error.
function cleanupDebugJournal(journalPath) {
  try {
    const debugPath = journalPath.replace(/\.json$/, '.debug.json');
    let st;
    try {
      st = fs.lstatSync(debugPath);
    } catch (e) {
      return; // File doesn't exist — nothing to clean up
    }
    if (st.isFile() && !st.isSymbolicLink()) {
      fs.unlinkSync(debugPath);
    }
  } catch (e) {
    // Silent fail — cleanup is best-effort
  }
}

// ---------------------------------------------------------------------------
// Fresh journal template
// ---------------------------------------------------------------------------

function newJournal(mission, project) {
  return {
    mission:        mission || '[pending]',
    mission_opened: new Date().toISOString(),
    mission_closed: null,
    project:        project || 'default',
    summary:        null,
    state:          'active',      // D3: 'active' | 'blocked' | 'waiting'
    state_reason:   null,          // D3: why blocked/waiting (max 120 chars)
    in_progress:    null,          // D1: { task, started, progress } for mid-task compaction
    completed:      [],
    upcoming:       [],
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getInstanceTag,
  getProjectTag,
  getClaudeDir,
  getJournalPath,
  // Debug utilities — forwarded from memento-debug.js when MEMENTO_DEBUG=1, no-ops otherwise
  getDebugJournalPath: debugModule ? debugModule.getDebugJournalPath : () => '',
  appendDebugEvents:   debugModule ? debugModule.appendDebugEvents   : () => {},
  readJournal,
  writeJournal,
  pruneJournal,
  formatJournalForInjection,
  newJournal,
  cleanupDebugJournal,
  DEBUG,
  MAX_COMPLETED,
  MAX_UPCOMING,
  MAX_SUMMARY_CHARS,
  MAX_JOURNAL_BYTES,
  STALE_DAYS,
};
