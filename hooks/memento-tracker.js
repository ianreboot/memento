#!/usr/bin/env node
// memento — UserPromptSubmit hook
//
// Runs on every user message. Two responsibilities:
//
//   1. Detect mission-closing events (/clear, explicit project shifts) and
//      mark the current mission as closed in the journal. This must happen
//      in the hook because /clear wipes the conversation — Claude never sees
//      the message and cannot act on it.
//
//   2. Emit a minimal per-turn reminder so Claude keeps updating the journal
//      throughout the session (not just at the start). The reminder is
//      injected as hidden system context — never shown to the user.
//
// This hook does NOT write journal entries. Claude writes those via the Write
// tool as instructed by the SKILL.md. This hook only handles mission lifecycle
// and the attention anchor.
//
// Performance: all I/O is minimal (read one small JSON file + conditional write).
// The hook must return quickly to avoid perceived latency. On a warm filesystem
// cache, the read + JSON parse completes in <5ms. The conditional write (only
// on /clear) uses the same atomic pattern as the main journal writer.

'use strict';

const fs = require('fs');
const {
  getInstanceTag,
  getProjectTag,
  getClaudeDir,
  getJournalPath,
  readJournal,
  writeJournal,
  appendDebugEvents,
  DEBUG,
} = require('./memento-config');

// Patterns that indicate the user is closing the current context.
// IMPORTANT: Be conservative — false-positive closure is data-destructive.
// Only match unambiguous, explicit context-switching phrases.
// Removed broad patterns (\bnew mission\b, \bdifferent project\b, \bfresh start\b,
// \bstart over\b) that match ordinary coding conversation.
const MISSION_CLOSE_PATTERNS = [
  /^\/clear$/i,                                                               // Exact /clear command
  /^\/new\s*mission\b/i,                                                      // Explicit /new-mission command
  /\bswitch(ing)?\s+to\s+a?\s*different\s+project\b/i,                       // "switching to a different project" (not "switch project to X")
  /\b(move|moving)\s+(on\s+to|to)\s+(a\s+)?(new|different)\s+project\b/i,   // "moving to a new project"
  /\bstart(ing)?\s+over\s+(from\s+scratch|completely)\b/i,                   // "starting over from scratch" (not "starting over the loop")
  /\bdone\s+with\s+(this|the\s+current)\s+(project|mission|session)\b/i,     // "done with this project"
];

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  try {
    run(rawInput);
  } catch (e) {
    // Silent fail — never block user prompt submission
    process.exit(0);
  }
});

function run(rawInput) {
  let prompt = '';
  try {
    const data = JSON.parse(rawInput);
    prompt = (data && data.prompt) ? String(data.prompt).trim() : '';
  } catch (e) { /* use empty string */ }

  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();   // file path (per-instance)
  const projectTag  = getProjectTag();    // current project (to keep journal.project current)
  const journalPath = getJournalPath(claudeDir, instanceTag);

  // 1. Detect mission-closing events
  const matchedPattern = MISSION_CLOSE_PATTERNS.find(re => re.test(prompt));
  if (matchedPattern) {
    const journal = readJournal(journalPath);
    if (journal && !journal.mission_closed) {
      const closedAt = new Date().toISOString();
      journal.mission_closed = closedAt;
      journal.plan = [];      // clear plan on close — closed mission has no pending tasks
      writeJournal(journalPath, journal);
      if (DEBUG) {
        appendDebugEvents(journalPath, [{
          type: 'lifecycle',
          data: {
            type:            'mission_closed',
            ts:              closedAt,
            mission:         journal.mission,
            trigger:         'hook_pattern_match',
            pattern_matched: matchedPattern.toString(),
          },
        }]);
      }
    }
    // Don't emit a reminder — the mission is closing, not continuing
    process.exit(0);
  }

  // 2. Emit per-turn reminder if a journal exists with an active mission.
  //    Also auto-update journal.project if git says we've moved to a different project.
  const journal = readJournal(journalPath);

  // Health check: journal file exists but is corrupt or unreadable.
  // Tell Claude to rewrite it before the session drifts further without journaling.
  if (!journal) {
    try {
      const st = fs.lstatSync(journalPath);
      if (st.isFile() && !st.isSymbolicLink()) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `[MEMENTO] Journal at ${journalPath} is corrupt or unreadable. ` +
              `Use the Write tool to create a fresh journal at that path. ` +
              `Minimal structure: {"mission":"[current goal]","mission_opened":"${new Date().toISOString()}",` +
              `"mission_closed":null,"project":"${projectTag}","summary":null,"wip":null,"done":[],"plan":[]}`,
          },
        }));
      }
    } catch (e) { /* file doesn't exist — normal on first run, no action needed */ }
    process.exit(0);
  }

  if (journal && journal.mission) {
    if (!journal.mission_closed) {
      // Active mission — sync project tag, then emit staleness-aware reminder.
      if (projectTag && projectTag !== 'default' && journal.project !== projectTag) {
        journal.project = projectTag;
        writeJournal(journalPath, journal);
      }

      const done = Array.isArray(journal.done) ? journal.done : (Array.isArray(journal.completed) ? journal.completed : []);
      const lastEntry = done.length > 0 ? done[done.length - 1] : null;
      const wip = journal.wip || (journal.in_progress ? journal.in_progress.task : null) || null;

      // Staleness detection: if the last completed entry is > 30 min old the journal
      // may be behind current work. Escalate the reminder until Claude writes again
      // (a write resets the timestamp and the escalation stops automatically).
      const STALE_REMINDER_MS = 30 * 60 * 1000;
      const lastEntryMs = lastEntry && lastEntry.ts ? new Date(lastEntry.ts).getTime() : 0;
      const isStale = !!(lastEntry && (Date.now() - lastEntryMs > STALE_REMINDER_MS));

      let detail;
      if (isStale) {
        const mins = Math.round((Date.now() - lastEntryMs) / 60000);
        detail = ` | last task ${mins} min ago — journal may be stale, write completed tasks before proceeding`;
      } else if (wip) {
        detail = ` | wip: "${wip}"`;
      } else if (lastEntry) {
        detail = ` | last: "${lastEntry.act || lastEntry.task || ''}"`;
      } else {
        // No entries and no wip — session is completely unprotected against compaction.
        // Escalate the reminder so Claude captures intent before any task runs.
        detail = ' | no entries yet — open mission is unprotected, write journal now';
      }

      const reminder = `[MEMENTO: "${journal.mission}"${detail}] Update journal when information that compaction would destroy changes.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: reminder,
        },
      }));
    } else {
      // Closed mission — prompt Claude to open a new one if this is new work.
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '[MEMENTO] Prior mission closed. If this is new work, open a new mission now — ' +
            'write journal with mission_opened reset, mission_closed:null, done:[], plan:[first task].',
        },
      }));
    }
  }

  process.exit(0);
}
