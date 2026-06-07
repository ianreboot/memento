#!/usr/bin/env node
// memento — SessionStart hook (v0.8.4)
//
// Runs once per session start (including after compaction and on resume).
//
// Two responsibilities:
//   1. Resolve conversation identity via JSONL anchor (write/update anchor).
//      Reset fixed per-instance turn counter — no conversation hash needed.
//   2. Emit a MANDATORY WRITE prompt appropriate for the session source:
//        compact / resume → Recovery prompt (Variant 8)
//        startup / unknown → Turn 1 prompt (Variant 1/2/3)
//
// For recovery sessions the turn counter is reset to 1 (not 0) so the first
// UserPromptSubmit emits a compressed Turn 2 prompt rather than the full
// Turn 1 prompt again — the Recovery prompt already covered that.
//
// Never blocks session start. Silent-fails on any error.

'use strict';

const fs = require('fs');
const {
  getInstanceTag,
  getProjectHash,
  getClaudeDir,
  getJournalPath,
  getFixedTurnPath,
  getFixedLastCtxPath,
  resolveConversation,
  readJournal,
  getCtxBridgePath,
  readCtxBridge,
  deleteCtxBridge,
  BRIDGE_MAX_AGE_MS,
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
  let transcriptPath = null;
  try {
    const data = JSON.parse(rawInput);
    source = (data && data.source) ? String(data.source).toLowerCase() : 'startup';
    if (data && typeof data.transcript_path === 'string') transcriptPath = data.transcript_path;
  } catch (e) { /* use defaults */ }

  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const isRecovery  = (source === 'compact' || source === 'resume');

  // Resolve conversation identity from the live transcript on stdin (authoritative),
  // refreshing the session anchor so this and every later hook track the live
  // conversation rather than a prior session's frozen transcript.
  const { conversationHash, jsonlPath } = resolveConversation(claudeDir, instanceTag, transcriptPath);
  const projectTranscript = jsonlPath || transcriptPath;
  const effectiveHash = conversationHash || getProjectHash(projectTranscript);

  const journalPath = getJournalPath(claudeDir, instanceTag, effectiveHash);
  const journal     = readJournal(journalPath);

  // Reset fixed per-instance turn counter (no conversation hash needed).
  // Recovery: start at 1 so next UserPromptSubmit emits compressed Turn 2.
  // Fresh start: reset to 0 so next UserPromptSubmit emits full Turn 1.
  const turnPath = getFixedTurnPath(claudeDir, instanceTag);
  try {
    fs.writeFileSync(turnPath, isRecovery ? '1' : '0', { mode: 0o600 });
  } catch (e) { /* silent */ }

  // On a fresh (non-recovery) start, clear the last-ctx token total so the first
  // UserPromptSubmit drop-detection cannot misfire against a prior session's value.
  if (!isRecovery) {
    try { fs.unlinkSync(getFixedLastCtxPath(claudeDir, instanceTag)); } catch (e) { /* silent */ }
  }

  // Bridge consumption is gated by source. A resume/compact reattaches to the same
  // conversation, so its bridge is correct by construction. A fresh startup/clear
  // only recovers a bridge written recently (BRIDGE_MAX_AGE_MS) — an unrelated older
  // session's bridge never surfaces. The bridge is one-shot: deleted once read.
  //
  // The bridge is keyed by PROJECT hash, not conversation hash. Its whole purpose is
  // to carry intent from a finished conversation into the next, DIFFERENT one — which
  // has a new conversation hash. Keying it by conversation hash (as v0.7.0–v0.8.0 did)
  // made the fresh-start handoff structurally impossible: the new session looked up a
  // bridge under a hash the prior session never wrote. The journal stays
  // conversation-scoped (per-conversation why-chains); the bridge is project-scoped.
  const bridgePath = getCtxBridgePath(claudeDir, getProjectHash(projectTranscript));
  const bridge     = readCtxBridge(bridgePath);
  let bridgeStr = '';
  if (bridge) {
    if (isRecovery || bridgeIsRecent(bridge)) {
      bridgeStr = buildBridgeInjection(bridge) + '\n';
    }
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
  const runway   = formatBridgeRunway(bridge);
  return `[CTX BRIDGE] Written ${runway} | Files: ${filesStr}\n` +
         `Prior session: "${bridge.next}"${errStr} - verify still relevant\n` +
         `Read the listed files before resuming work.`;
}

// Human-readable runway label. Prefers v0.8.0 `left` (tokens to compaction);
// falls back to a pre-v0.8.0 `pct` bridge so an upgrade is seamless.
function formatBridgeRunway(bridge) {
  if (typeof bridge.left === 'number') return `~${Math.max(0, Math.round(bridge.left / 1000))}k tokens left`;
  if (typeof bridge.pct === 'number')  return `at ${bridge.pct}%`;
  return 'runway unknown';
}

// A bridge is recent if it was written within BRIDGE_MAX_AGE_MS. Unparseable or
// missing timestamps are treated as not-recent (a fresh start won't surface them).
function bridgeIsRecent(bridge) {
  if (!bridge || typeof bridge.at !== 'string') return false;
  const t = Date.parse(bridge.at);
  if (isNaN(t)) return false;
  return (Date.now() - t) <= BRIDGE_MAX_AGE_MS;
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
