#!/usr/bin/env node
// memento — UserPromptSubmit hook (v0.4.1)
//
// Runs on every user message. Emits a MANDATORY WRITE prompt so Claude
// writes its current 'why' to the journal before the next tool call.
//
// Turn 1  (sidecar = 0): full prompt with schema template
// Turn N+ (sidecar > 0): compressed one-line prompt with previous why shown
//
// The hook does NOT write journal entries. Claude writes those via the Write
// tool as instructed by SKILL.md. This hook only emits prompts and manages
// the turn counter sidecar.
//
// Silent-fails on any filesystem error — must never block user prompts.

'use strict';

const fs = require('fs');
const {
  getInstanceTag,
  getClaudeDir,
  getJournalPath,
  getTurnSidecarPath,
  readJournal,
} = require('./memento-config');

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
  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const journalPath = getJournalPath(claudeDir, instanceTag);
  const turnPath    = getTurnSidecarPath(journalPath);

  // Read current turn counter (0 = Turn 1, >0 = Turn N)
  let turn = 0;
  try {
    const stored = parseInt(fs.readFileSync(turnPath, 'utf8').trim(), 10);
    if (!isNaN(stored) && stored >= 0) turn = stored;
  } catch (e) { /* missing sidecar — treat as turn 0 (Turn 1) */ }

  // Increment and persist the turn counter
  const nextTurn = turn + 1;
  try { fs.writeFileSync(turnPath, String(nextTurn), { mode: 0o600 }); } catch (e) { /* silent */ }

  const journal = readJournal(journalPath);
  const why     = journal && typeof journal.why === 'string' ? journal.why : null;
  const when    = journal && journal.when ? journal.when : null;

  let prompt;
  if (turn === 0) {
    prompt = buildTurn1Prompt(journalPath, why, when);
  } else {
    prompt = buildTurnNPrompt(journalPath, nextTurn, why);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: prompt,
    },
  }));
  process.exit(0);
}

// Turn 1: full prompt with schema template (Variants 1/2/3 based on journal state)
function buildTurn1Prompt(journalPath, why, when) {
  const header = `[MEMENTO] MANDATORY WRITE | Turn 1 | path: ${journalPath}`;

  if (!why) {
    // Variant 1: no prior journal (or old-schema journal)
    return `${header}\nNo prior journal. Why are we doing this?\n` +
           `Write your current why. [GUESS] always valid if intent is unclear.\n` +
           `{"why":"<intent or [GUESS] best inference>","when":"<ISO>","why_history":[]}`;
  }

  const isGuess  = why.startsWith('[GUESS]');
  const prevWhen = when || '<prev-ISO>';

  if (isGuess) {
    // Variant 3: previous why was a [GUESS]
    return `${header}\nWhy are we doing this? Previous: ${why}\n` +
           `Write your current why. Drop [GUESS] only if you have direct evidence (user statement, task description). Otherwise keep [GUESS].\n` +
           `{"why":"...","when":"<ISO>","why_history":[{"w":"${why}","t":"${prevWhen}"}]}`;
  }

  // Variant 2: confirmed previous why
  return `${header}\nWhy are we doing this? Previous: "${why}"\n` +
         `Write your current why. [GUESS] always valid. Same is fine.\n` +
         `{"why":"...","when":"<ISO>","why_history":[{"w":"${why}","t":"${prevWhen}"}]}`;
}

// Turn N: compressed single-line prompt (Variants 4/5/6 based on journal state)
function buildTurnNPrompt(journalPath, turnNum, why) {
  const header = `[MEMENTO] MANDATORY WRITE | Turn ${turnNum} | path: ${journalPath}`;

  if (!why) {
    // Variant 6: no journal written yet (T1 was skipped — edge case)
    return `${header}\nNo journal written yet. Why are we doing this? Write why+when (purpose, not action). [GUESS] ok.\n` +
           `{"why":"<intent or [GUESS]>","when":"<ISO>","why_history":[]}`;
  }

  const isGuess = why.startsWith('[GUESS]');
  if (isGuess) {
    // Variant 5: previous why is a [GUESS]
    return `${header}\nPrevious: ${why} | Write why+when (purpose, not action). Drop [GUESS] if you now have direct evidence. Same ok.`;
  }

  // Variant 4: confirmed previous why
  return `${header}\nPrevious: "${why}" | Write why+when (purpose, not action). [GUESS] ok. Same ok.`;
}
