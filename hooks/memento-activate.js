#!/usr/bin/env node
// memento — SessionStart hook
//
// Runs once per session start (including after compaction and on resume).
// Reads the journal for the current project and injects it as hidden system
// context so Claude can orient itself without any visible user output.
//
// Injection depth depends on why the session is starting:
//   source "compact" or "resume" → full journal (recovery mode)
//   source "startup" or unknown  → brief one-liner (save tokens on fresh sessions)
//
// The journal path is included in the header so Claude knows where to write
// updates via the Write tool. Claude is the only writer for task entries —
// this hook may write for housekeeping only (pruning, project tag updates).
//
// If the journal is missing, corrupt, or too large, this hook exits silently.
// It never blocks session start.
//
// Debug mode (MEMENTO_DEBUG=1): logs a session boundary event and injection
// details to the shadow debug journal for post-session forensics.

'use strict';

const {
  getInstanceTag,
  getProjectTag,
  getClaudeDir,
  getJournalPath,
  readJournal,
  pruneJournal,
  writeJournal,
  formatJournalForInjection,
  appendDebugEvents,
  cleanupDebugJournal,
  DEBUG,
} = require('./memento-config');

// Read hook input from stdin — Claude Code sends a JSON object with:
//   { session_id, source, ... }
// source values: "startup" | "compact" | "resume"
let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  try {
    run(rawInput);
  } catch (e) {
    // Silent fail — never block session start
    process.exit(0);
  }
});

function run(rawInput) {
  let source    = 'startup';
  let sessionId = null;
  try {
    const data = JSON.parse(rawInput);
    source    = (data && data.source)     ? String(data.source).toLowerCase()    : 'startup';
    sessionId = (data && data.session_id) ? String(data.session_id)              : null;
  } catch (e) { /* use defaults */ }

  const claudeDir    = getClaudeDir();
  const instanceTag  = getInstanceTag();          // determines the file path (per-instance)
  const projectTag   = getProjectTag();           // current project (for journal.project field)
  const journalPath  = getJournalPath(claudeDir, instanceTag);
  const now         = new Date().toISOString();

  // If debug mode is off, clean up any stale debug journal left over from
  // a previous debug session. Runs silently on every session start.
  if (!DEBUG) {
    cleanupDebugJournal(journalPath);
  }

  // Log session boundary regardless of whether journal exists
  if (DEBUG) {
    appendDebugEvents(journalPath, [{
      type: 'session',
      data: { session_id: sessionId, started_at: now, source, ended_at: null },
    }]);
  }

  let journal = readJournal(journalPath);
  if (!journal) {
    // No journal yet — emit path hint so Claude knows the canonical path to
    // write to. Without this, Claude cannot know which path the hook expects,
    // and may write to a different path that never gets injected.
    const hint = `[MEMENTO] No prior journal | instance:${instanceTag} | proj:${projectTag} | path:${journalPath}\n` +
                 `Create journal at the path above when the mission is clear. Set project field to "${projectTag}".`;
    if (DEBUG) {
      const hintBytes = Buffer.byteLength(hint, 'utf8');
      appendDebugEvents(journalPath, [{
        type: 'injection',
        data: {
          ts:              now,
          hook:            'memento-activate.js',
          source,
          mode:            'path_hint',
          pruned:          false,
          journal_existed: false,
          entries_injected: 0,
          bytes_injected:  hintBytes,
        },
      }]);
    }
    process.stdout.write(hint);
    process.exit(0);
  }

  // Auto-update journal.project if git says we're in a different project now.
  // This keeps the project field current as the user moves between projects,
  // without requiring any manual action from Claude.
  if (projectTag && projectTag !== 'default' && journal.project !== projectTag) {
    journal.project = projectTag;
  }

  // Prune stale/oversized entries and persist the cleaned journal.
  // This is the only write that happens in the activate hook, and only
  // occurs if pruning actually changed anything (including project field update above).
  const originalJson = JSON.stringify(journal);
  const pruneResult  = DEBUG ? pruneJournal(journal, { debug: true }) : pruneJournal(journal);
  const pruned       = DEBUG ? pruneResult.journal : pruneResult;
  const wasPruned    = JSON.stringify(pruned) !== originalJson;

  if (wasPruned) {
    writeJournal(journalPath, pruned);
    journal = pruned;
    // Flush prune debug events (writeJournal already wrote them via its own
    // debug path, but pruneJournal events from activate need to be flushed too)
    if (DEBUG && pruneResult.debugEvents && pruneResult.debugEvents.length > 0) {
      appendDebugEvents(journalPath, pruneResult.debugEvents);
    }
  }

  // Determine injection depth
  const isRecovery = (source === 'compact' || source === 'resume');
  const mode = isRecovery ? 'full' : 'brief';

  const output = formatJournalForInjection(journal, mode, journalPath);

  if (DEBUG) {
    const completedCount = (Array.isArray(journal.completed) ? journal.completed : []).filter(Boolean).length;
    appendDebugEvents(journalPath, [{
      type: 'injection',
      data: {
        ts:              now,
        hook:            'memento-activate.js',
        source,
        mode,
        pruned:          wasPruned,
        journal_existed: true,
        entries_injected: completedCount,
        bytes_injected:  output ? Buffer.byteLength(output, 'utf8') : 0,
      },
    }]);
  }

  if (output) {
    process.stdout.write(output);
  }

  process.exit(0);
}
