#!/usr/bin/env node
// memento — PreCompact hook
//
// Runs before context compaction fires. If the journal exists but wip is not set,
// emits a checkpoint prompt so Claude has a chance to write current task state
// before the compaction window closes.
//
// If wip is already set (journal is already checkpointed), exits silently.
// If no journal exists, exits silently — nothing to checkpoint.
// On any error, exits 0 silently — must never block compaction.
//
// Output format: raw text to stdout (same as SessionStart / memento-activate.js).
// PreCompact receives JSON input via stdin ({ trigger, session_id, ... }) but
// this hook only needs the journal path, derived from the instance tag.

'use strict';

const {
  getClaudeDir,
  getInstanceTag,
  getJournalPath,
  readJournal,
} = require('./memento-config.js');

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  try {
    main();
  } catch (e) {
    // Silent fail — must never block compaction
    process.exit(0);
  }
});

function main() {
  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const journalPath = getJournalPath(claudeDir, instanceTag);
  const journal     = readJournal(journalPath);

  // Only prompt if journal exists and wip is not already set.
  // If wip is set, the journal is already checkpointed — no action needed.
  // If no journal, there is nothing to checkpoint.
  if (!journal || journal.wip) {
    process.exit(0);
    return;
  }

  const message =
    `[MEMENTO] Context compaction about to fire. ` +
    `If mid-task, write current state to journal now — set wip before compaction clears the context window. ` +
    `Path: ${journalPath}`;
  process.stdout.write(message + '\n');
  process.exit(0);
}
