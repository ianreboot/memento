#!/usr/bin/env node
// memento — PreCompact hook (v0.8.2)
//
// Runs before context compaction. Does two things:
//
// 1. Emits a MANDATORY WRITE prompt so Claude records its current 'why'
//    before context clears (best-effort — tool use may not be available
//    during compaction, but the prompt is there if it is).
//
// 2. Writes ctx_bridge.json directly (no dependency on Claude writing it):
//    - Primary: spawns `claude -p` with a fresh context window, pipes the
//      session transcript tail as stdin, parses AI-extracted {files, next, err}.
//    - Fallback: if claude -p fails, writes a minimal bridge from journal.why.
//    - Skip: if a bridge already exists (written by tracker at ≥74% ctx —
//      richer, with files the tracker's Claude was actively editing).
//
// On any error, exits 0 silently — must never block compaction.

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
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
  getLastWhyPath,
  readLastWhy,
  BRIDGE_MAX_AGE_MS,
  CLAUDE_BIN,
  WRITE_SCRIPT_PATH,
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

  // Live transcript on stdin (stat-validated; falls back to latest scan).
  const transcriptPath = resolveTranscript(rawInput, claudeDir);

  // Resolve conversation identity from the live transcript (refreshes the anchor).
  const { conversationHash, jsonlPath: anchoredJsonl } = resolveConversation(claudeDir, instanceTag, transcriptPath);
  const projectTranscript = anchoredJsonl || transcriptPath;
  const effectiveHash = conversationHash || getProjectHash(projectTranscript);
  const journalPath   = getJournalPath(claudeDir, instanceTag, effectiveHash);
  const journal       = readJournal(journalPath);

  // Compute runway (tokens to compaction) for the bridge's `left` annotation,
  // against the per-conversation-resolved window (env → latch → 200k).
  const jsonlPath = anchoredJsonl || transcriptPath || findLatestJsonl(claudeDir);
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

  const why  = journal && typeof journal.why === 'string' ? journal.why : null;
  const when = journal && journal.when ? journal.when : null;

  // Write ctx_bridge.json if not already written by tracker.
  // Tracker's bridge is richer (Claude knew which files it was editing).
  // Here we only write if no bridge exists yet.
  //
  // Project-scoped key (not conversation-scoped): the bridge must be readable by the
  // NEXT conversation, which has a different conversation hash. See activate.js.
  const projectHash = getProjectHash(projectTranscript);

  // Bridge source falls back to the project-scoped last_why mirror when the live-transcript
  // journal has no why — write-why (CLI, no transcript_path) can file the journal under a
  // different conversation hash than this hook reads; a project-scoped record sidesteps that.
  // See activate.js / last_why. The AI-extracted bridge is preferred when available; this
  // only backstops the minimal fallback path.
  let bridgeWhy = why;
  let bridgeAt = null;
  if (!bridgeWhy) {
    const lw = readLastWhy(getLastWhyPath(claudeDir, projectHash), BRIDGE_MAX_AGE_MS);
    if (lw) { bridgeWhy = lw.why; bridgeAt = lw.at; }
  }

  const bridgePath = getCtxBridgePath(claudeDir, projectHash);
  if (!readCtxBridge(bridgePath)) {
    const written = transcriptPath && tryWriteAiBridge(bridgePath, transcriptPath, left);
    if (!written && bridgeWhy) {
      // Fallback: minimal bridge from journal.why (no files, no err)
      writeCtxBridge(bridgePath, {
        files: [],
        next:  bridgeWhy,
        err:   null,
        left,
        at:    bridgeAt || new Date().toISOString(),
      });
    }
  }

  // Emit MANDATORY WRITE prompt (best-effort — Claude may not be able to
  // use Write tool during compaction, but prompt is injected regardless)
  const header = `[MEMENTO] MANDATORY WRITE — LAST WRITE OPPORTUNITY | path: ${journalPath}`;

  let message;
  if (!why) {
    message = `${header}\nNo prior journal. Why are we doing this?\n` +
              `Always write why (purpose, not action) before context clears. [GUESS] always valid.\n` +
              `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  } else {
    const isGuess   = why.startsWith('[GUESS]');
    const prevLabel = isGuess ? why : `"${why}"`;
    message = `${header}\nWhy are we doing this? Previous: ${prevLabel}\n` +
              `Always write why (purpose, not action) before context clears. [GUESS] always valid.\n` +
              `node ${WRITE_SCRIPT_PATH} '<your why>'`;
  }

  process.stdout.write(message + '\n');
  process.exit(0);
}

// Resolve transcript path: prefer stdin transcript_path, fallback to findLatestJsonl.
function resolveTranscript(rawInput, claudeDir) {
  try {
    const input = JSON.parse(rawInput);
    if (input.transcript_path && typeof input.transcript_path === 'string') {
      const tp = input.transcript_path.trim();
      if (tp) {
        try { fs.statSync(tp); return tp; } catch (e) {}
      }
    }
  } catch (e) {}
  return findLatestJsonl(claudeDir);
}

// Spawn `claude -p` with transcript tail piped to stdin.
// Parse JSON output and write ctx_bridge.json.
// Returns true on success, false on any failure (caller handles fallback).
function tryWriteAiBridge(bridgePath, transcriptPath, left) {
  try {
    // Read last 32KB of transcript
    const stat = fs.statSync(transcriptPath);
    const tail = Math.min(32768, stat.size);
    const buf  = Buffer.alloc(tail);
    const fd   = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buf, 0, tail, stat.size - tail); }
    finally { fs.closeSync(fd); }
    const transcriptTail = buf.toString('utf8');

    const prompt = [
      'Analyze this Claude Code session transcript (JSONL format). Extract recovery state.',
      'Output ONLY a single-line JSON object — no explanation, no markdown:',
      '{"files":["<path>"],"next":"<exact next step, max 300 chars>","err":"<error or null>"}',
      '',
      'Rules:',
      '- files: up to 5 absolute paths recently written/edited (look for Write/Edit tool calls in last few turns)',
      '- next: exact next action to resume this session (specific, not vague)',
      '- err: current error being debugged as a string, or JSON null if none',
      '- If unclear: use [] for files, infer next from conversation context',
    ].join('\n');

    const result = spawnSync(CLAUDE_BIN, ['-p', prompt], {
      input:    transcriptTail,
      encoding: 'utf8',
      timeout:  30000,
    });

    if (result.status !== 0 || !result.stdout) return false;

    const extracted = parseJsonOutput(result.stdout);
    if (!extracted || typeof extracted.next !== 'string') return false;

    writeCtxBridge(bridgePath, {
      files: Array.isArray(extracted.files) ? extracted.files : [],
      next:  extracted.next,
      err:   extracted.err || null,
      left,
      at:    new Date().toISOString(),
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Parse JSON from claude's output — handles extra whitespace and markdown fences.
function parseJsonOutput(output) {
  // Scan lines in reverse — last non-empty JSON object is the answer
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch (e) {}
    }
  }
  // Strip markdown fences and try the whole output
  const stripped = output.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();
  try { return JSON.parse(stripped); } catch (e) {}
  return null;
}
