#!/usr/bin/env node
// memento — debug shadow journal utilities (v0.4.0)
//
// Loaded only when MEMENTO_DEBUG=1. Maintains a shadow journal that records
// every write event and session boundary without affecting the main journal.
// Useful for post-session forensics when diagnosing write compliance.
//
// Design: silent-fail on all I/O. Debug mode must never block the session.

'use strict';

const fs   = require('fs');
const path = require('path');

// Maximum size for the debug file. Never pruned, grows across a session.
const MAX_DEBUG_BYTES = 2 * 1024 * 1024; // 2MB

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

// ~/.claude/.memento/alice.json -> ~/.claude/.memento/alice.debug.json
function getDebugJournalPath(journalPath) {
  return journalPath.replace(/\.json$/, '.debug.json');
}

// ---------------------------------------------------------------------------
// Debug shadow journal I/O
// ---------------------------------------------------------------------------

function readDebugJournal(debugPath) {
  try {
    const st = fs.lstatSync(debugPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > MAX_DEBUG_BYTES) return null;
    return JSON.parse(fs.readFileSync(debugPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function freshDebugJournal() {
  return {
    debug_since:    new Date().toISOString(),
    write_seq:      0,
    sessions:       [],   // session boundaries (one per Claude Code session start)
    write_events:   [],   // every why write Claude made
    write_failures: [],   // silent-fail events from writeJournal
  };
}

function writeDebugJournal(debugPath, data) {
  const tmp = debugPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'w' });
    fs.renameSync(tmp, debugPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Append a batch of debug events to the shadow journal.
//
// event.type values:
//   'write'         — Claude wrote {why, when, why_history} to the main journal
//   'write_failure' — writeJournal aborted without writing
//   'session'       — session boundary (new Claude Code session started)
//
// Silent-fails if the debug file is missing, corrupt, or too large.
function appendDebugEvents(journalPath, events) {
  if (!events || events.length === 0) return;
  try {
    const debugPath = getDebugJournalPath(journalPath);
    let dbg = readDebugJournal(debugPath) || freshDebugJournal();

    dbg.write_seq = (dbg.write_seq || 0) + 1;

    for (const event of events) {
      switch (event.type) {
        case 'write':
          dbg.write_events.push(event.data);
          break;
        case 'write_failure':
          dbg.write_failures.push(event.data);
          break;
        case 'session':
          dbg.sessions.push(event.data);
          break;
      }
    }

    writeDebugJournal(debugPath, dbg);
  } catch (e) {
    // Silent fail
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getDebugJournalPath,
  readDebugJournal,
  freshDebugJournal,
  writeDebugJournal,
  appendDebugEvents,
};
