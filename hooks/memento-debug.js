#!/usr/bin/env node
// memento — debug shadow journal utilities
//
// This module is loaded only when MEMENTO_DEBUG=1. It provides a shadow
// journal that accumulates all entries, prune events, injections, and
// lifecycle events without affecting the main journal. Useful for
// post-session forensics when diagnosing journaling behavior.
//
// Conditionally required by memento-config.js:
//   const debugModule = DEBUG ? require('./memento-debug') : null;
//
// Design: silent-fail on all I/O. Debug mode must never block the session.

'use strict';

const fs   = require('fs');
const path = require('path');

// Field limits for detectTruncations — must stay in sync with FIELD_LIMITS in memento-config.js
const FIELD_LIMITS = { act: 80, result: 120, ctx: 120 };

// Maximum size for the debug file. Unlike the main journal it is never pruned,
// so it grows across a session. We refuse to write past this limit.
const MAX_DEBUG_BYTES = 2 * 1024 * 1024; // 2MB

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

// Returns the path to the debug shadow journal, derived from the main journal path.
// Example: ~/.claude/.memento/alice.json → ~/.claude/.memento/alice.debug.json
function getDebugJournalPath(journalPath) {
  return journalPath.replace(/\.json$/, '.debug.json');
}

// ---------------------------------------------------------------------------
// Debug shadow journal I/O
// ---------------------------------------------------------------------------

// Read the debug journal file. Less strict than readJournal — no symlink
// protection (path is derived from the already-validated journal path) but
// still enforces the size cap to prevent runaway growth.
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

// Create a fresh debug journal structure.
function freshDebugJournal(project) {
  return {
    project:            project || 'unknown',
    debug_since:        new Date().toISOString(),
    write_seq:          0,
    sessions:           [],   // session boundaries (one per Claude Code session)
    lifecycle_events:   [],   // mission open/close/reopen
    injections:         [],   // what memento-activate.js injected each session start
    collapse_events:    [],   // stale collapses (batch prune of all entries)
    write_failures:     [],   // silent-fail events from writeJournal
    summary_history:    [],   // each time summary was updated (rolling folds + trims)
    upcoming_mutations: [],   // additions/removals to the upcoming[] array
    entries:            [],   // all entries ever written (never pruned here)
  };
}

// Atomically write the debug journal. Uses a simpler form of the atomic
// pattern (no symlink check) since the path is derived from the already-
// validated main journal path and lives in the same directory.
function writeDebugJournal(debugPath, data) {
  const tmp = debugPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'w' });
    fs.renameSync(tmp, debugPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    // Silent fail — debug mode must never block the session
  }
}

// Append a batch of events to the debug shadow journal.
// Reads the debug journal, applies each event to the appropriate array,
// increments write_seq, then atomically writes back.
//
// event.type values:
//   'entry_written'       — new entry added to main journal
//   'entry_rolled'        — entry folded into summary (rolling window)
//   'entry_status_update' — update an existing entry's _debug.status (e.g. stale prune)
//   'summary_history'     — summary field was updated (fold or stale collapse)
//   'collapse'            — stale collapse: all entries wiped at once
//   'write_failure'       — writeJournal aborted without writing
//   'lifecycle'           — mission opened, closed, or reopened
//   'injection'           — memento-activate.js ran (whether or not it injected)
//   'session'             — session boundary (new Claude Code session started)
//   'upcoming_mutation'   — item added to or removed from upcoming[]
//
// Silent-fails entirely if the debug file is missing, corrupt, or too large.
function appendDebugEvents(journalPath, events) {
  if (!events || events.length === 0) return;
  try {
    const debugPath = getDebugJournalPath(journalPath);
    let dbg = readDebugJournal(debugPath);
    if (!dbg) {
      const project = path.basename(journalPath, '.json');
      dbg = freshDebugJournal(project);
    }

    dbg.write_seq = (dbg.write_seq || 0) + 1;
    const seq = dbg.write_seq;

    for (const event of events) {
      switch (event.type) {

        case 'entry_written': {
          if (event.data && event.data._debug) event.data._debug.write_seq = seq;
          // If we already recorded this entry (e.g. from a prune event first),
          // update it; otherwise append.
          const idx = dbg.entries.findIndex(
            e => e.ts === event.data.ts && e.act === event.data.act
          );
          if (idx >= 0) {
            dbg.entries[idx] = { ...dbg.entries[idx], ...event.data };
          } else {
            dbg.entries.push(event.data);
          }
          break;
        }

        case 'entry_rolled': {
          // Find existing entry and update its _debug block; if not found, insert.
          const idx = dbg.entries.findIndex(
            e => e.ts === event.entry.ts && e.act === event.entry.act
          );
          if (idx >= 0) {
            dbg.entries[idx]._debug = Object.assign(dbg.entries[idx]._debug || {}, {
              status:             'would_roll_summary',
              rolled_at:          event.rolled_at,
              summary_text_added: event.summary_text_added,
            });
          } else {
            dbg.entries.push({
              ...event.entry,
              _debug: {
                status:             'would_roll_summary',
                written_at:         event.entry.ts,
                rolled_at:          event.rolled_at,
                summary_text_added: event.summary_text_added,
                write_seq:          seq,
              },
            });
          }
          break;
        }

        case 'entry_status_update': {
          const idx = dbg.entries.findIndex(
            e => e.ts === event.ts && e.act === event.act
          );
          if (idx >= 0) {
            dbg.entries[idx]._debug = Object.assign(dbg.entries[idx]._debug || {}, {
              status:    event.new_status,
              pruned_at: event.pruned_at,
            });
          }
          break;
        }

        case 'summary_history':
          dbg.summary_history.push(event.data);
          break;

        case 'collapse':
          dbg.collapse_events.push(event.data);
          break;

        case 'write_failure':
          dbg.write_failures.push(event.data);
          break;

        case 'lifecycle':
          dbg.lifecycle_events.push(event.data);
          break;

        case 'injection':
          dbg.injections.push(event.data);
          break;

        case 'session':
          dbg.sessions.push(event.data);
          break;

        case 'upcoming_mutation':
          dbg.upcoming_mutations.push(event.data);
          break;
      }
    }

    writeDebugJournal(debugPath, dbg);
  } catch (e) {
    // Silent fail — debug events are best-effort, never block the session
  }
}

// ---------------------------------------------------------------------------
// Debug helpers — compare old/new journals to generate debug events
// ---------------------------------------------------------------------------

// Compare entry field lengths against FIELD_LIMITS before applyFieldLimits()
// runs. Returns a map of { [ts]: { truncated_fields, original_lengths } }
// for any entry that would have at least one field truncated.
function detectTruncations(data) {
  const result = {};
  const entries = data && (Array.isArray(data.done) ? data.done : Array.isArray(data.completed) ? data.completed : null);
  if (!entries) return result;
  for (const entry of entries) {
    if (!entry || !entry.ts) continue;
    const truncatedFields = [];
    const originalLengths = {};
    for (const field of ['act', 'result', 'ctx']) {
      if (typeof entry[field] === 'string' && entry[field].length > FIELD_LIMITS[field]) {
        truncatedFields.push(field);
        originalLengths[field] = entry[field].length;
      }
    }
    if (truncatedFields.length > 0) {
      result[entry.ts] = { truncated_fields: truncatedFields, original_lengths: originalLengths };
    }
  }
  return result;
}

// Return entries in newJournal.done that are not present in oldJournal.done
// (matched by ts + act). These are entries Claude just added.
function findNewEntries(oldJournal, newJournal) {
  const newDone = newJournal && (Array.isArray(newJournal.done) ? newJournal.done : Array.isArray(newJournal.completed) ? newJournal.completed : null);
  if (!newDone) return [];
  const oldDone = oldJournal && (Array.isArray(oldJournal.done) ? oldJournal.done : Array.isArray(oldJournal.completed) ? oldJournal.completed : []) || [];
  const oldKeys = new Set(oldDone.filter(Boolean).map(e => `${e.ts}|${e.act || e.task}`));
  return newDone.filter(Boolean).filter(e => e && !oldKeys.has(`${e.ts}|${e.act || e.task}`));
}

// Compare plan arrays and return mutation events for items added or removed.
function diffUpcoming(oldJournal, newJournal, now) {
  const events = [];
  const oldUp = (oldJournal && (Array.isArray(oldJournal.plan) ? oldJournal.plan : Array.isArray(oldJournal.upcoming) ? oldJournal.upcoming : [])).filter(Boolean);
  const newUp = (newJournal && (Array.isArray(newJournal.plan) ? newJournal.plan : Array.isArray(newJournal.upcoming) ? newJournal.upcoming : [])).filter(Boolean);
  for (const task of newUp) {
    if (!oldUp.includes(task)) {
      events.push({ type: 'upcoming_mutation', data: { ts: now, type: 'added', task, trigger: 'claude_write' } });
    }
  }
  for (const task of oldUp) {
    if (!newUp.includes(task)) {
      events.push({ type: 'upcoming_mutation', data: { ts: now, type: 'removed', task, trigger: 'claude_write' } });
    }
  }
  return events;
}

// Detect mission state changes between old and new journals and return lifecycle events.
function detectMissionLifecycle(oldJournal, newJournal, now) {
  const events = [];
  if (!newJournal) return events;

  const oldMission = oldJournal ? oldJournal.mission : null;
  const newMission = newJournal.mission;
  const oldClosed  = oldJournal ? oldJournal.mission_closed : undefined;
  const newClosed  = newJournal.mission_closed;

  // Journal created for the first time
  if (!oldJournal && newMission) {
    events.push({ type: 'lifecycle', data: { type: 'mission_opened', mission: newMission, ts: now, trigger: 'first_write' } });
    return events;
  }

  // Mission text changed
  if (oldMission !== newMission && newMission) {
    events.push({ type: 'lifecycle', data: { type: 'mission_changed', old_mission: oldMission, new_mission: newMission, ts: now } });
  }

  // Closed / reopened
  if (!oldClosed && newClosed) {
    events.push({ type: 'lifecycle', data: { type: 'mission_closed', mission: newMission, ts: now, trigger: 'claude_write' } });
  } else if (oldClosed && !newClosed) {
    events.push({ type: 'lifecycle', data: { type: 'mission_reopened', mission: newMission, ts: now } });
  }

  return events;
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
  detectTruncations,
  findNewEntries,
  diffUpcoming,
  detectMissionLifecycle,
};
