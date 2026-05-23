#!/usr/bin/env node
// memento — SessionStart hook (v0.5.6)
//
// Runs once per session start (including after compaction and on resume).
//
// Two responsibilities:
//   1. Reset the turn counter sidecar so UserPromptSubmit can distinguish
//      Turn 1 (full prompt) from Turn N (compressed prompt).
//   2. Emit a MANDATORY WRITE prompt appropriate for the session source:
//        compact / resume → Recovery prompt (Variant 8)
//        startup / unknown → Turn 1 prompt (Variant 1/2/3)
//
// For recovery sessions the sidecar is reset to 1 (not 0) so the first
// UserPromptSubmit emits a compressed Turn 2 prompt rather than the full
// Turn 1 prompt again — the Recovery prompt already covered that.
//
// Never blocks session start. Silent-fails on any error.

'use strict';

const fs = require('fs');
const {
  getInstanceTag,
  getClaudeDir,
  getJournalPath,
  getTurnSidecarPath,
  readJournal,
  getCtxBridgePath,
  readCtxBridge,
  deleteCtxBridge,
  WRITE_SCRIPT_PATH,
} = require('./memento-config');

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
  let source = 'startup';
  try {
    const data = JSON.parse(rawInput);
    source = (data && data.source) ? String(data.source).toLowerCase() : 'startup';
  } catch (e) { /* use defaults */ }

  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const journalPath = getJournalPath(claudeDir, instanceTag);
  const turnPath    = getTurnSidecarPath(journalPath);

  const isRecovery = (source === 'compact' || source === 'resume');
  const journal    = readJournal(journalPath);

  // Reset turn counter.
  // Recovery: start at 1 so the next UserPromptSubmit emits compressed Turn 2
  // (the Recovery prompt already served as the full Turn 1 prompt).
  // Fresh start: reset to 0 so the next UserPromptSubmit emits full Turn 1.
  try {
    fs.writeFileSync(turnPath, isRecovery ? '1' : '0', { mode: 0o600 });
  } catch (e) { /* silent */ }

  // Always consume bridge if present — file existence is the signal, not source.
  // Previous: only consumed on source=startup, leaving bridge stale on source=compact/resume.
  const bridgePath = getCtxBridgePath(claudeDir);
  const bridge     = readCtxBridge(bridgePath);
  let bridgeStr = '';
  if (bridge) {
    bridgeStr = buildBridgeInjection(bridge) + '\n';
    deleteCtxBridge(bridgePath);
  }

  let output = '';
  if (isRecovery) {
    output = bridgeStr + buildRecoveryPrompt(journal, journalPath);
  } else {
    output = bridgeStr + buildTurn1Prompt(journal, journalPath);
  }

  if (output) process.stdout.write(output);
  process.exit(0);
}

function buildBridgeInjection(bridge) {
  const filesStr = bridge.files && bridge.files.length > 0 ? bridge.files.join(', ') : '(none)';
  const errStr   = bridge.err ? ` | Error: ${bridge.err}` : '';
  return `[CTX BRIDGE] Written at ${bridge.pct ?? '?'}% | Files: ${filesStr}\n` +
         `Next: "${bridge.next}"${errStr}\n` +
         `Read the listed files before resuming work.`;
}

// Variant 8: Recovery — post-compaction session start
function buildRecoveryPrompt(journal, journalPath) {
  const header = `[MEMENTO] Recovering | path: ${journalPath}`;
  const why    = journal && typeof journal.why === 'string' ? journal.why : null;
  const when   = journal && journal.when ? journal.when : null;

  if (!why) {
    return `${header}\nNo prior journal. Why are we doing this?\n` +
           `MANDATORY WRITE — Write your current why (purpose, not action) before your first tool call. [GUESS] always valid.\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  const isGuess   = why.startsWith('[GUESS]');
  const prevLabel = isGuess ? why : `"${why}"`;
  const whenStr   = when ? ` | Set: ${when}` : '';

  // Build arc from why_history (chain of previous why values)
  const history = (journal.why_history || []).filter(e => e && typeof e.w === 'string');
  const arcStr  = history.length > 0
    ? '\nArc: ' + [...history.map(e => `"${e.w}"`), `"${why}"`].join(' \u2192 ')
    : '';

  return `${header}\nWhy: ${prevLabel}${whenStr}${arcStr}\n` +
         `MANDATORY WRITE — Why are we doing this? Confirm or update why (purpose, not action) before your first tool call. [GUESS] always valid.\n` +
         `node ${WRITE_SCRIPT_PATH} '<your why>'`;
}

// Variants 1/2/3: Turn 1 — fresh session start
function buildTurn1Prompt(journal, journalPath) {
  const header = `[MEMENTO] MANDATORY WRITE | Turn 1 | path: ${journalPath}`;
  const why    = journal && typeof journal.why === 'string' ? journal.why : null;
  const when   = journal && journal.when ? journal.when : null;

  if (!why) {
    // Variant 1: No journal (or old-schema journal treated as non-existent)
    return `${header}\nNo prior journal. Why are we doing this?\n` +
           `Write your current why (purpose, not action). [GUESS] always valid if intent is unclear.\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  const isGuess  = why.startsWith('[GUESS]');

  if (isGuess) {
    // Variant 3: [GUESS] why — encourage upgrade if evidence is available
    return `${header}\nWhy are we doing this? Previous: ${why}\n` +
           `Write your current why (purpose, not action). Drop [GUESS] only if you have direct evidence (user statement, task description). Otherwise keep [GUESS].\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  // Variant 2: Confirmed why — cheapest write (same is fine)
  return `${header}\nWhy are we doing this? Previous: "${why}"\n` +
         `Write your current why (purpose, not action). [GUESS] always valid. Same is fine.\n` +
         `node ${WRITE_SCRIPT_PATH} '<your why>'`;
}
