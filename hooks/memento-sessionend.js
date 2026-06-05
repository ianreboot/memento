#!/usr/bin/env node
// memento — SessionEnd hook (v0.8.0)
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
  resolveConversation,
  readJournal,
  getCtxBridgePath,
  getCtxWinPath,
  resolveWindow,
  compactionPointFor,
  findLatestJsonl,
  readLastUsage,
  readCtxBridge,
  writeCtxBridge,
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

  // Live transcript on stdin (authoritative); falls back to anchor/scan.
  let transcriptPath = null;
  try {
    const data = JSON.parse(rawInput);
    if (data && typeof data.transcript_path === 'string') transcriptPath = data.transcript_path;
  } catch (e) { /* no stdin / not JSON */ }

  // Resolve conversation identity from the live transcript (refreshes the anchor).
  const { conversationHash, jsonlPath: anchoredJsonl } = resolveConversation(claudeDir, instanceTag, transcriptPath);
  const effectiveHash = conversationHash || getProjectHash();
  const journalPath   = getJournalPath(claudeDir, instanceTag, effectiveHash);
  const journal       = readJournal(journalPath);

  // Compute runway (tokens to compaction) for the bridge's `left` annotation.
  const jsonlPath = anchoredJsonl || findLatestJsonl(claudeDir);
  let left = null;
  if (jsonlPath) {
    const usage = readLastUsage(jsonlPath);
    if (usage) {
      const total = (usage.input_tokens || 0) +
                    (usage.cache_read_input_tokens || 0) +
                    (usage.cache_creation_input_tokens || 0);
      const window = resolveWindow(total, getCtxWinPath(journalPath));
      left = Math.max(0, compactionPointFor(window) - total);
    }
  }

  const why = journal && typeof journal.why === 'string' ? journal.why : null;

  // Write minimal bridge only if none exists. Existing bridge (tracker near the
  // compaction point or PreCompact) is richer — preserve it.
  const bridgePath = getCtxBridgePath(claudeDir, effectiveHash);
  if (!readCtxBridge(bridgePath) && why) {
    writeCtxBridge(bridgePath, {
      files: [],
      next:  why,
      err:   null,
      left,
      at:    new Date().toISOString(),
    });
  }

  process.exit(0);
}
