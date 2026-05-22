#!/usr/bin/env node
// memento — PreCompact hook (v0.4.1)
//
// Runs before context compaction. Always emits a MANDATORY WRITE prompt so
// Claude records its current 'why' before context clears. The write is
// mandatory regardless of current journal state — this is the last chance
// to capture intent before the compaction window closes.
//
// On any error, exits 0 silently — must never block compaction.

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

  const why  = journal && typeof journal.why === 'string' ? journal.why : null;
  const when = journal && journal.when ? journal.when : null;

  const header = `[MEMENTO] MANDATORY WRITE — LAST WRITE OPPORTUNITY | path: ${journalPath}`;

  let message;
  if (!why) {
    message = `${header}\nNo prior journal. Why are we doing this?\n` +
              `Always write why+when (purpose, not action) before context clears. [GUESS] always valid.\n` +
              `{"why":"<intent or [GUESS] best inference>","when":"<ISO>","why_history":[]}`;
  } else {
    const isGuess   = why.startsWith('[GUESS]');
    const prevLabel = isGuess ? why : `"${why}"`;
    const prevWhen  = when || '<prev-ISO>';
    message = `${header}\nWhy are we doing this? Previous: ${prevLabel}\n` +
              `Always write why+when (purpose, not action) before context clears. Append to why_history only if why changed. [GUESS] always valid.\n` +
              `{"why":"...","when":"<ISO>","why_history":[...append {"w":"${why}","t":"${prevWhen}"} only if changed...]}`;
  }

  process.stdout.write(message + '\n');
  process.exit(0);
}
