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
//   mission:400 + summary:300 + 6×(act:80+result:120+ctx:120+ts:24) + 3×plan:150
//   ≈ 3000 bytes + JSON formatting overhead. 6KB provides safe headroom.
// Files exceeding this are treated as corrupt and replaced with a fresh journal.
const MAX_JOURNAL_BYTES = parseInt(process.env.MEMENTO_MAX_FILE_KB || '', 10) * 1024 || 6 * 1024;

// Rolling window: keep at most this many done entries before summarizing.
// At ~25 tokens/entry in injection format, 6 entries ≈ 150 tokens — negligible
// against a 200k context window. Configurable via MEMENTO_MAX_ENTRIES (range 4–24).
const MAX_COMPLETED = Math.max(4, Math.min(24, parseInt(process.env.MEMENTO_MAX_ENTRIES || '', 10) || 6));

// Maximum plan items to track. Event-driven design means fewer, higher-quality anchors.
const MAX_UPCOMING = 3;

// Summary field max length in characters. 300 chars fits ~4-5 folded entries,
// providing meaningful historical breadth at negligible token cost (~75 tokens).
const MAX_SUMMARY_CHARS = 300;

// How old (in days) the newest completed entry can be before the journal is
// considered stale. Stale journals are collapsed to summary on SessionStart.
const STALE_DAYS = parseInt(process.env.MEMENTO_STALE_DAYS || '', 10) || 7;

// Character limits enforced on individual entry fields before writing.
const FIELD_LIMITS = { act: 80, result: 120, ctx: 120, mission: 400, wip: 150 };

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

    // Basic schema validation — must have a mission (string or null; bare wip journals have null)
    if (typeof journal !== 'object' || journal === null) return null;
    if (journal.mission !== null && typeof journal.mission !== 'string') return null;
    if (journal.completed !== undefined && !Array.isArray(journal.completed)) return null;
    if (journal.upcoming !== undefined && !Array.isArray(journal.upcoming)) return null;
    if (journal.done !== undefined && !Array.isArray(journal.done)) return null;
    if (journal.plan !== undefined && !Array.isArray(journal.plan)) return null;

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

// Collapse newlines to spaces so injected text stays one line per field.
function sanitizeLine(s) {
  return s.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function applyFieldLimits(journal) {
  const j = Object.assign({}, journal);
  if (typeof j.mission === 'string') {
    j.mission = sanitizeLine(j.mission.slice(0, FIELD_LIMITS.mission));
  }

  // subject: Claude-managed field for what the work is actually about.
  // Distinct from project (which reflects git context). null means "use project".
  if (typeof j.subject === 'string') {
    j.subject = sanitizeLine(j.subject.slice(0, FIELD_LIMITS.act)); // reuse act limit (80 chars)
  } else {
    j.subject = null;
  }

  // Normalize done entries (backward-compat: fall back to completed for old journals).
  // Write only the new 'done' field name — old 'completed' fades out on next write.
  const rawDone = Array.isArray(j.done) ? j.done : (Array.isArray(j.completed) ? j.completed : []);
  j.done = rawDone.filter(Boolean).map(entry => {
    // backward-compat: old entries use 'task', new entries use 'act'
    const act = typeof entry.act === 'string' ? entry.act : (typeof entry.task === 'string' ? entry.task : '');
    return {
      act:    sanitizeLine(act.slice(0, FIELD_LIMITS.act)),
      result: sanitizeLine(typeof entry.result === 'string' ? entry.result.slice(0, FIELD_LIMITS.result) : ''),
      // C1: preserve absent ctx as absent — SKILL.md says "omit the field entirely" when unknown.
      // Coercing undefined→'' makes absent indistinguishable from empty, losing that signal.
      ...(typeof entry.ctx === 'string' ? { ctx: sanitizeLine(entry.ctx.slice(0, FIELD_LIMITS.ctx)) } : {}),
      ts:     typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
    };
  });
  delete j.completed; // remove old field name

  // Normalize plan items (backward-compat: fall back to upcoming for old journals).
  const rawPlan = Array.isArray(j.plan) ? j.plan : (Array.isArray(j.upcoming) ? j.upcoming : []);
  j.plan = rawPlan.filter(Boolean).slice(0, MAX_UPCOMING).map(t => sanitizeLine(String(t).slice(0, 150)));
  delete j.upcoming; // remove old field name

  // Normalize wip (backward-compat: extract from in_progress.progress for old journals).
  // wip is a plain string, not an object — fold blocker/state info directly into it.
  if (typeof j.wip === 'string') {
    j.wip = sanitizeLine(j.wip.slice(0, FIELD_LIMITS.wip)) || null;
  } else if (j.wip == null) {
    if (j.in_progress && typeof j.in_progress.progress === 'string' && j.in_progress.progress) {
      j.wip = sanitizeLine(j.in_progress.progress.slice(0, FIELD_LIMITS.wip)) || null;
    } else {
      j.wip = null;
    }
  } else {
    j.wip = null;
  }
  delete j.in_progress; // remove old field name

  // Drop state/state_reason — folded into wip string in v0.2.0
  delete j.state;
  delete j.state_reason;

  if (typeof j.summary === 'string') {
    j.summary = sanitizeLine(j.summary.slice(0, MAX_SUMMARY_CHARS)) || null;
  }

  return j;
}

// ---------------------------------------------------------------------------
// Journal pruning
// ---------------------------------------------------------------------------

// Prune the journal to fit within rolling window constraints.
//
// Rules (applied in order):
//   1. Check staleness: if newest entry is > STALE_DAYS old, collapse all
//      completed entries into summary and clear the array (cross-session reset)
//   2. Rolling window: if done.length > MAX_COMPLETED (6): fold oldest entry into
//      summary; trim summary from the start if it exceeds MAX_SUMMARY_CHARS
//   3. Cap plan array to MAX_UPCOMING items
//
// opts.debug: if true, returns { journal, debugEvents } instead of just the journal.
// When opts is omitted, behaves exactly as before — backward-compatible.
function pruneJournal(journal, opts) {
  const dbg = opts && opts.debug;
  if (!journal) return dbg ? { journal, debugEvents: [] } : journal;

  const now = new Date().toISOString();
  const debugEvents = [];

  const j = JSON.parse(JSON.stringify(journal)); // deep copy

  // Normalize done array — backward-compat: accept either 'done' or 'completed'
  const completed = (Array.isArray(j.done) ? j.done : (Array.isArray(j.completed) ? j.completed : [])).filter(Boolean);
  j.done = completed;
  delete j.completed;
  // Normalize plan array — backward-compat: accept either 'plan' or 'upcoming'
  if (!Array.isArray(j.plan) && Array.isArray(j.upcoming)) { j.plan = j.upcoming; }
  if (!Array.isArray(j.plan)) j.plan = [];
  delete j.upcoming;

  // 1. Staleness check — if the newest entry is too old, collapse everything
  if (completed.length > 0) {
    const timestamps = completed.map(e => e && e.ts ? new Date(e.ts).getTime() : 0).filter(t => t > 0);
    const newestTs = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
    if (newestTs && !isNaN(newestTs)) {
      const ageDays = (Date.now() - newestTs.getTime()) / (1000 * 60 * 60 * 24);
      // Two-tier staleness: closed missions collapse at STALE_DAYS; active missions
      // get 2× the threshold so journals survive extended breaks without losing task detail.
      const staleThreshold = j.mission_closed ? STALE_DAYS : STALE_DAYS * 2;
      if (ageDays > staleThreshold) {
        // Capture debug events before mutating j
        if (dbg) {
          const upcomingCleared = Array.isArray(j.plan) ? j.plan.filter(Boolean).length : 0;
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
              stale_threshold_days:  staleThreshold,
              mission_was_closed:    !!j.mission_closed,
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
          // Plan items cleared by the collapse
          if (Array.isArray(j.plan)) {
            for (const task of j.plan.filter(Boolean)) {
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
        j.done = [];
        j.plan = [];
        j.wip = null;
        if (!j.mission_closed) j.mission_closed = now;
        return dbg ? { journal: j, debugEvents } : j;
      }
    }
  }

  // 2. Rolling window: fold oldest entries into summary until we're within cap
  while (j.done && j.done.length > MAX_COMPLETED) {
    const oldest = j.done.shift();
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

  // 3. Cap plan array
  if (Array.isArray(j.plan)) {
    j.plan = j.plan.filter(Boolean).slice(0, MAX_UPCOMING);
  }

  return dbg ? { journal: j, debugEvents } : j;
}

// Fold a completed entry into a brief summary line.
function entryToSummaryLine(entry) {
  if (!entry) return '';
  const act = entry.act || entry.task || '';
  const parts = [act];
  if (entry.result) parts.push(`-> ${entry.result}`);
  // Preserve ctx — carries forward-causation intent that act/result alone loses in summary
  if (typeof entry.ctx === 'string') parts.push(`(${entry.ctx})`);
  return parts.join(' ');
}

// Summarize a batch of entries into one line (used for stale collapse).
// Preserves ctx content — it carries forward-causation intent that pure act names lose.
function summarizeEntries(entries) {
  return entries.filter(Boolean).map(e => {
    const act = e.act || e.task || '';
    const ctx = typeof e.ctx === 'string' ? ` (${e.ctx})` : '';
    return act + ctx;
  }).join(', ');
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
function formatJournalForInjection(journal, mode, journalPath, projectTag, opts) {
  if (!journal) return '';

  // Feature B: previous project for stale-mission header annotation
  const previousProject = opts && opts.previousProject ? opts.previousProject : null;

  // Cross-project suppression: if the journal belongs to a different project,
  // the detailed entries are irrelevant noise regardless of mission status.
  // Keep only the mission signal and a one-line summary so the recovering Claude
  // knows the previous context briefly before pivoting to the current project.
  //
  // subject field: Claude-managed, set when the work is about a different project
  // than the current session (e.g., editing memento files during an AEO session).
  // When subject is set, it takes precedence over project for relevance checks.
  // When subject is null, fall through to the existing project-tag comparison.
  const relevantProject = (typeof journal.subject === 'string' && journal.subject)
    ? journal.subject
    : journal.project;
  const crossProject = !!(projectTag && projectTag !== 'default'
    && relevantProject && relevantProject !== 'default'
    && relevantProject !== projectTag);

  // Feature B: when cross-project suppression fires and the project has changed,
  // annotate the header so a recovering Claude knows the mission's origin project.
  const missionWas = (crossProject && previousProject && previousProject !== projectTag)
    ? ` (mission was: ${previousProject})` : '';

  // Feature C: allow null mission (bare wip journals have no active mission string).
  // Never output "Mission: null" or "Mission: [no mission set]".
  const missionStr = journal.mission ? journal.mission.slice(0, FIELD_LIMITS.mission) : null;
  const project = journal.project || 'default';
  const pathHint = journalPath ? ` | path:${journalPath}` : '';

  // Closed-mission suppression: when mission_closed is set, the previous work
  // is finished. Brief mode gets a minimal "no active mission" signal; full mode
  // (post-compaction recovery) retains the mission name and summary for orientation
  // but drops done entries, wip, and plan items — they are historical noise.
  if (journal.mission_closed) {
    if (mode === 'brief') {
      return `[MEMENTO] No active mission | proj:${project}${pathHint}`;
    }
    // Full mode: mission name + closed signal + summary only
    const closedLabel = missionStr ? `Mission: ${missionStr} (CLOSED)` : 'No active mission (CLOSED)';
    const lines = [`[MEMENTO] ${closedLabel} | proj:${project}${pathHint}`];
    if (journal.summary) {
      lines.push(`Sum: ${String(journal.summary).slice(0, MAX_SUMMARY_CHARS)}`);
    }
    return lines.join('\n');
  }

  // Backward-compat reads for renamed fields
  const done   = Array.isArray(journal.done)  ? journal.done  : (Array.isArray(journal.completed) ? journal.completed : []);
  const plan   = Array.isArray(journal.plan)  ? journal.plan  : (Array.isArray(journal.upcoming)  ? journal.upcoming  : []);
  const wipStr = typeof journal.wip === 'string' ? journal.wip
    : (journal.in_progress && journal.in_progress.progress ? journal.in_progress.progress : null);

  if (mode === 'brief') {
    if (!missionStr) {
      // No active mission (bare wip journal) — just show the header
      return `[MEMENTO] No active mission | proj:${project}${pathHint}`;
    }
    const doneFilt = done.filter(Boolean);
    const planFilt = plan.filter(Boolean);
    return `[MEMENTO] Mission: ${missionStr} | proj:${project}${pathHint}\n` +
           `${doneFilt.length} task(s) done, ${planFilt.length} pending. Update journal when information that compaction would destroy changes.`;
  }

  // Full injection (post-compaction recovery)
  const lines = [];
  const missionLabel = missionStr ? `Mission: ${missionStr}` : 'No active mission';
  lines.push(`[MEMENTO] ${missionLabel} | proj:${project}${missionWas}${pathHint}`);

  if (crossProject) {
    // Suppress detailed entries from a different, closed project — they are irrelevant noise.
    // Preserve only the mission-closed signal (already in the header) and a one-line summary.
    const firstAct = done.length > 0 ? (done[0].act || done[0].task || null) : null;
    const xpSummary = journal.summary || firstAct;
    if (xpSummary) lines.push(`Previous work (${relevantProject}): ${String(xpSummary).slice(0, MAX_SUMMARY_CHARS)}`);
  } else {
    // WIP first — a recovering Claude needs to know immediately if work was in progress.
    // Showing wip before done entries means it is never obscured by a long task history.
    if (wipStr) {
      lines.push(`WIP: ${String(wipStr).slice(0, FIELD_LIMITS.wip)}`);
    }

    if (journal.summary) {
      lines.push(`Sum: ${String(journal.summary).slice(0, MAX_SUMMARY_CHARS)}`);
    }

    const doneEntries = done.slice(0, MAX_COMPLETED).filter(Boolean);
    for (const entry of doneEntries) {
      // backward-compat: old entries use 'task', new entries use 'act'
      const act    = (typeof entry.act === 'string' ? entry.act : (typeof entry.task === 'string' ? entry.task : '')).slice(0, FIELD_LIMITS.act);
      const result = (typeof entry.result === 'string' ? entry.result : '').slice(0, FIELD_LIMITS.result);
      const ctx    = (typeof entry.ctx    === 'string' ? entry.ctx    : '').slice(0, FIELD_LIMITS.ctx);
      let line = `Done: ${act}`;
      if (result) line += ` -> ${result}`;
      if (ctx)    line += ` | ctx: ${ctx}`;
      lines.push(line);
    }

    const planItems = plan.slice(0, MAX_UPCOMING).filter(Boolean);
    if (planItems.length > 0) {
      const firstItem = String(planItems[0]).slice(0, 150);
      const planStr = planItems.length === 1
        ? firstItem
        : `${firstItem} + ${planItems.length - 1} more`;
      lines.push(`Plan: ${planStr}`);
    }
  }

  // No footer paragraph — SKILL.md already contains the behavioral spec.
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
    subject:        null,           // what the work is about (Claude-set, overrides project for suppression)
    summary:        null,
    wip:            null,           // mid-task state or blocker string (max 150 chars)
    done:           [],             // completed entries: { act, result, ctx?, ts }
    plan:           [],             // next steps with causal anchors (max 3)
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
