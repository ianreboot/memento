#!/usr/bin/env node
// memento — SessionEnd hook (v0.6.0)
//
// Runs when Claude Code session ends (clean exit, crash, or interrupt).
// Writes a minimal ctx_bridge.json from journal.why so that on restart,
// activate.js injects recovery context on session start.
//
// Design: no claude -p call here. SessionEnd hooks have a tight exit timeout
// and spawning a nested claude process caused "Hook cancelled" before the
// write could complete. Minimal bridge (why → next) is sufficient and runs
// in milliseconds.
//
// Skip if a bridge already exists (tracker at ≥74% or PreCompact wrote
// a richer one — don't overwrite it).
//
// Silent-fail on all errors — must never block session exit.

'use strict';

const {
  getClaudeDir,
  getInstanceTag,
  getProjectHash,
  getJournalPath,
  readJournal,
  getCtxBridgePath,
  findLatestJsonl,
  readLastUsage,
  readCtxBridge,
  writeCtxBridge,
  CONTEXT_WINDOW,
} = require('./memento-config.js');

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  try {
    main();
  } catch (e) {
    // Silent fail — must never block session exit
    process.exit(0);
  }
});

function main() {
  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const projectHash = getProjectHash();
  const journalPath = getJournalPath(claudeDir, instanceTag, projectHash);
  const journal     = readJournal(journalPath);

  // Read current ctx% for pct field in bridge
  const jsonlPath = findLatestJsonl(claudeDir);
  let usedPct = null;
  if (jsonlPath) {
    const usage = readLastUsage(jsonlPath);
    if (usage) {
      const total = (usage.input_tokens || 0) +
                    (usage.cache_read_input_tokens || 0) +
                    (usage.cache_creation_input_tokens || 0);
      usedPct = total / CONTEXT_WINDOW * 100;
    }
  }

  const why = journal && typeof journal.why === 'string' ? journal.why : null;

  // Write minimal bridge only if none exists. Existing bridge (tracker at ≥74%
  // or PreCompact) is richer — preserve it.
  const bridgePath = getCtxBridgePath(claudeDir, projectHash);
  if (!readCtxBridge(bridgePath) && why) {
    writeCtxBridge(bridgePath, {
      files: [],
      next:  why,
      err:   null,
      pct:   usedPct !== null ? Math.round(usedPct) : null,
      at:    new Date().toISOString(),
    });
  }

  process.exit(0);
}
