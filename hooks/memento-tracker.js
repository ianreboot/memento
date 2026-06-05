#!/usr/bin/env node
// memento — UserPromptSubmit hook (v0.8.1)
//
// Runs on every user message. Emits a MANDATORY WRITE prompt so Claude
// writes its current 'why' to the journal before the next tool call.
//
// Turn 1  (counter = 0): full prompt with schema template; writes session anchor
//                        if SessionStart didn't (rare startup race)
// Turn N+ (counter > 0): compressed one-line prompt with previous why shown
//
// The hook does NOT write journal entries. Claude writes those via the Write
// tool as instructed by SKILL.md. This hook only emits prompts and manages
// the turn counter.
//
// Silent-fails on any filesystem error — must never block user prompts.

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
  readLastCtxTokens,
  writeLastCtxTokens,
  readJournal,
  getCtxWinPath,
  resolveWindow,
  compactionPointFor,
  getCtxBridgePath,
  findLatestJsonl,
  readLastUsage,
  readCtxBridge,
  deleteCtxBridge,
  BRIDGE_TRIGGER_TOKENS,
  BRIDGE_SPIKE_TOKENS,
  CTX_DROP_TOKENS,
  WRITE_SCRIPT_PATH,
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

  // The live transcript path Claude Code hands every hook on stdin. Authoritative
  // for the current session — keeps ctx tracking off any stale anchor (Defect 1).
  let transcriptPath = null;
  try {
    const data = JSON.parse(rawInput);
    if (data && typeof data.transcript_path === 'string') transcriptPath = data.transcript_path;
  } catch (e) { /* no stdin / not JSON — fall back to anchor */ }

  // Resolve conversation identity. The live transcript_path wins; at T1 this also
  // (re)writes the session anchor. Falls back to anchor/scan when stdin lacks it.
  const { conversationHash, jsonlPath } = resolveConversation(claudeDir, instanceTag, transcriptPath);
  const effectiveHash = conversationHash || getProjectHash();
  const journalPath   = getJournalPath(claudeDir, instanceTag, effectiveHash);

  // Fixed per-instance turn counter and last-ctx paths (no hash dependency)
  const turnPath    = getFixedTurnPath(claudeDir, instanceTag);
  const lastCtxPath = getFixedLastCtxPath(claudeDir, instanceTag);

  // Read current turn counter (0 = Turn 1, >0 = Turn N)
  let turn = 0;
  try {
    const stored = parseInt(fs.readFileSync(turnPath, 'utf8').trim(), 10);
    if (!isNaN(stored) && stored >= 0) turn = stored;
  } catch (e) { /* missing counter — treat as turn 0 (Turn 1) */ }

  // Increment and persist the turn counter
  const nextTurn = turn + 1;
  try { fs.writeFileSync(turnPath, String(nextTurn), { mode: 0o600 }); } catch (e) { /* silent */ }

  const journal = readJournal(journalPath);
  const why     = journal && typeof journal.why === 'string' ? journal.why : null;
  const when    = journal && journal.when ? journal.when : null;

  // Compute context usage from JSONL. Use anchored path when available; fall back to
  // scan when resolveConversation returned null jsonlPath (MEMENTO_PROJECT_HASH override).
  const ctxJsonlPath = jsonlPath || findLatestJsonl(claudeDir);
  const ctxWinPath   = getCtxWinPath(journalPath);
  let total = null, cacheWrite = 0, tokensToCompaction = null, window = null;
  if (ctxJsonlPath) {
    const usage = readLastUsage(ctxJsonlPath);
    if (usage) {
      total = (usage.input_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0);
      cacheWrite = usage.cache_creation_input_tokens || 0;
      // Resolve the real window (env → per-conversation latch → 200k) and measure
      // runway as absolute tokens to the compaction point — constant across windows.
      window = resolveWindow(total, ctxWinPath);
      tokensToCompaction = compactionPointFor(window) - total;
    }
  }

  // Project-scoped bridge key (not conversation-scoped): the bridge is a cross-
  // conversation handoff, so it must use a key stable across conversations. The same
  // path serves in-session compaction re-injection (projectHash is stable within a
  // session too) and the cross-session pickup in activate.js. See activate.js.
  const bridgePath = getCtxBridgePath(claudeDir, getProjectHash());

  // Drop detection: a real drop in total context tokens means a compaction just
  // occurred (context only grows between turns otherwise). Measured in tokens, so a
  // mid-session window re-resolution can never look like a compaction.
  // Primary: total dropped ≥ CTX_DROP_TOKENS from last_ctx (normal per-turn tracking).
  // Fallback: no last_ctx (first run post-install or it was lost) but a bridge exists —
  // compare against the bridge's own write position (compaction point − bridge.left).
  // If current usage is ≥ CTX_DROP_TOKENS below where the bridge was written, a
  // compaction happened between then and now.
  const lastTotal = readLastCtxTokens(lastCtxPath);
  const bridge = readCtxBridge(bridgePath);
  let ctxBridgeStr = '';
  const compactionDetected = total !== null && (() => {
    if (lastTotal !== null) return (lastTotal - total) >= CTX_DROP_TOKENS;
    if (!bridge || tokensToCompaction === null) return false;
    const bridgeLeft = typeof bridge.left === 'number' ? bridge.left : 0;
    return (tokensToCompaction - bridgeLeft) >= CTX_DROP_TOKENS;
  })();
  if (compactionDetected && bridge) {
    ctxBridgeStr = buildBridgeInjection(bridge) + '\n';
    deleteCtxBridge(bridgePath);
  }

  // bridgeExists computed AFTER potential deletion above
  const bridgeExists = (() => {
    try { return fs.lstatSync(bridgePath).isFile(); } catch (e) { return false; }
  })();

  // Bridge directive fires when runway to compaction is short, or a large cache-write
  // spike lands while past the window midpoint (a sudden jump could reach compaction
  // before the next turn). Both are absolute-token tests against the resolved window.
  const shouldBridge = tokensToCompaction !== null && (
    tokensToCompaction <= BRIDGE_TRIGGER_TOKENS ||
    (cacheWrite > BRIDGE_SPIKE_TOKENS && total > window / 2 && !bridgeExists)
  );

  let prompt;
  if (turn === 0) {
    prompt = buildTurn1Prompt(journalPath, why, when);
  } else {
    prompt = buildTurnNPrompt(journalPath, nextTurn, why);
  }

  // Prepend [CTX BRIDGE] recovery context if a compaction was detected
  if (ctxBridgeStr) {
    prompt = ctxBridgeStr + prompt;
  }

  if (shouldBridge) {
    prompt += '\n' + buildBridgeDirective(bridgePath, tokensToCompaction);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: prompt,
    },
  }));

  // Persist current context-token total for next turn's drop detection
  if (total !== null) writeLastCtxTokens(lastCtxPath, total);

  process.exit(0);
}

// Turn 1: full prompt with schema template (Variants 1/2/3 based on journal state)
function buildTurn1Prompt(journalPath, why, when) {
  const header = `[MEMENTO] MANDATORY WRITE | Turn 1 | path: ${journalPath}`;

  if (!why) {
    // Variant 1: no prior journal (or old-schema journal)
    return `${header}\nNo prior journal. Why are we doing this?\n` +
           `Write your current why (purpose, not action). [GUESS] always valid if intent is unclear.\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  const isGuess  = why.startsWith('[GUESS]');

  if (isGuess) {
    // Variant 3: previous why was a [GUESS]
    return `${header}\nWhy are we doing this? Previous: ${why}\n` +
           `Write your current why (purpose, not action). Drop [GUESS] only if you have direct evidence (user statement, task description). Otherwise keep [GUESS].\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  // Variant 2: confirmed previous why
  return `${header}\nWhy are we doing this? Previous: "${why}"\n` +
         `Write your current why (purpose, not action). [GUESS] always valid. Same is fine.\n` +
         `node ${WRITE_SCRIPT_PATH} '<your why>'`;
}

// [CTX BRIDGE] injection — prepended to prompt when drop detection fires on compaction recovery
function buildBridgeInjection(bridge) {
  const filesStr = bridge.files && bridge.files.length > 0 ? bridge.files.join(', ') : '(none)';
  const errStr   = bridge.err ? ` | Error: ${bridge.err}` : '';
  const runway   = formatBridgeRunway(bridge);
  return `[CTX BRIDGE] Written ${runway} | Files: ${filesStr}\n` +
         `Prior session: "${bridge.next}"${errStr} - verify still relevant\n` +
         `Read the listed files before resuming work.`;
}

// Human-readable runway label for a bridge. Prefers the v0.8.0 `left` (tokens to
// compaction); falls back to a pre-v0.8.0 `pct` bridge so an upgrade is seamless.
function formatBridgeRunway(bridge) {
  if (typeof bridge.left === 'number') return `~${Math.max(0, Math.round(bridge.left / 1000))}k tokens left`;
  if (typeof bridge.pct === 'number')  return `at ${bridge.pct}%`;
  return 'runway unknown';
}

// [BRIDGE] directive — appended when runway to compaction is short or a cache-write spike lands
function buildBridgeDirective(bridgePath, tokensToCompaction) {
  const left = Math.max(0, Math.round(tokensToCompaction));
  return `[BRIDGE] ~${Math.round(left / 1000)}k tokens until compaction — write ctx_bridge.json before next tool call. path: ${bridgePath}\n` +
    `List files you are actively editing, your exact next step, current error or null. Full overwrite.\n` +
    `{"files":["path1"],"next":"<exact next step>","err":null,"left":${left},"at":"<ISO>"}`;
}

// Turn N: compressed single-line prompt (Variants 4/5/6 based on journal state)
function buildTurnNPrompt(journalPath, turnNum, why) {
  const header = `[MEMENTO] MANDATORY WRITE | Turn ${turnNum} | path: ${journalPath}`;

  if (!why) {
    // Variant 6: no journal written yet (T1 was skipped — edge case)
    return `${header}\nNo journal written yet. Why are we doing this? [GUESS] ok.\n` +
           `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  const isGuess = why.startsWith('[GUESS]');
  if (isGuess) {
    // Variant 5: previous why is a [GUESS]
    return `${header}\nPrevious: ${why} | node ${WRITE_SCRIPT_PATH} '<your why>'. Drop [GUESS] if you now have direct evidence. Same ok.`;
  }

  // Variant 4: confirmed previous why
  return `${header}\nPrevious: "${why}" | node ${WRITE_SCRIPT_PATH} '<your why>'. [GUESS] ok. Same ok.`;
}
