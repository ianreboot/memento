#!/usr/bin/env node
// memento — UserPromptSubmit hook (v0.7.0)
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
  readLastCtxPct,
  writeLastCtxPct,
  readJournal,
  getCtxBridgePath,
  findLatestJsonl,
  readLastUsage,
  readCtxBridge,
  deleteCtxBridge,
  CONTEXT_WINDOW,
  BRIDGE_TRIGGER_PCT,
  BRIDGE_SPIKE_TOKENS,
  CTX_DROP_THRESHOLD,
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

  // Resolve conversation identity. At T1, this also writes the session anchor
  // if SessionStart didn't (rare startup race). At T2+, reads existing anchor.
  const { conversationHash, jsonlPath } = resolveConversation(claudeDir, instanceTag);
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
  let usedPct = null, cacheWrite = 0;
  if (ctxJsonlPath) {
    const usage = readLastUsage(ctxJsonlPath);
    if (usage) {
      const total = (usage.input_tokens || 0) +
                    (usage.cache_read_input_tokens || 0) +
                    (usage.cache_creation_input_tokens || 0);
      usedPct    = total / CONTEXT_WINDOW * 100;
      cacheWrite = usage.cache_creation_input_tokens || 0;
    }
  }

  const bridgePath = getCtxBridgePath(claudeDir, effectiveHash);

  // Drop detection: a significant ctx% drop means a compaction just occurred.
  // Primary: ctx% dropped ≥ CTX_DROP_THRESHOLD from last_ctx (normal per-turn tracking).
  // Fallback: no last_ctx exists (first run post-install or last_ctx lost) — use bridge.pct
  // as the reference. A ≥ CTX_DROP_THRESHOLD drop from bridge.pct to current ctx means
  // compaction occurred between when the bridge was written and now.
  // If bridge has no pct field, fall back to usedPct < BRIDGE_TRIGGER_PCT heuristic.
  const lastCtxPct = readLastCtxPct(lastCtxPath);
  const bridge = readCtxBridge(bridgePath);
  let ctxBridgeStr = '';
  const compactionDetected = usedPct !== null && (() => {
    if (lastCtxPct !== null) return (lastCtxPct - usedPct) >= CTX_DROP_THRESHOLD;
    if (!bridge) return false;
    // Fallback: compare against bridge's own pct (precise) or trigger threshold (coarse)
    const refPct = typeof bridge.pct === 'number' ? bridge.pct : BRIDGE_TRIGGER_PCT;
    return (refPct - usedPct) >= CTX_DROP_THRESHOLD;
  })();
  if (compactionDetected && bridge) {
    ctxBridgeStr = buildBridgeInjection(bridge) + '\n';
    deleteCtxBridge(bridgePath);
  }

  // bridgeExists computed AFTER potential deletion above
  const bridgeExists = (() => {
    try { return fs.lstatSync(bridgePath).isFile(); } catch (e) { return false; }
  })();

  const shouldBridge = usedPct !== null && (
    usedPct >= BRIDGE_TRIGGER_PCT ||
    (cacheWrite > BRIDGE_SPIKE_TOKENS && usedPct > 60 && !bridgeExists)
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
    prompt += '\n' + buildBridgeDirective(bridgePath, usedPct);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: prompt,
    },
  }));

  // Persist current ctx% for next turn's drop detection
  if (usedPct !== null) writeLastCtxPct(lastCtxPath, usedPct);

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
  return `[CTX BRIDGE] Written at ${bridge.pct ?? '?'}% | Files: ${filesStr}\n` +
         `Prior session: "${bridge.next}"${errStr} - verify still relevant\n` +
         `Read the listed files before resuming work.`;
}

// [BRIDGE] directive — appended to prompt when context is ≥74% or cache-write spike detected
function buildBridgeDirective(bridgePath, pct) {
  return `[BRIDGE] context at ${pct.toFixed(1)}% — write ctx_bridge.json before next tool call. path: ${bridgePath}\n` +
    `List files you are actively editing, your exact next step, current error or null. Full overwrite.\n` +
    `{"files":["path1"],"next":"<exact next step>","err":null,"pct":${Math.round(pct)},"at":"<ISO>"}`;
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
