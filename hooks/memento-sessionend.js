#!/usr/bin/env node
// memento — SessionEnd hook (v0.5.4)
//
// Runs when Claude Code session ends (clean exit, crash, or interrupt).
// Writes ctx_bridge.json via `claude -p` so that on restart (without
// compaction), activate.js injects recovery context on session start.
//
// Mirrors memento-precompact.js bridge-writing logic:
// - Skip if a bridge already exists (tracker at ≥74% or PreCompact wrote
//   a richer one — don't overwrite it)
// - Primary: AI extraction via claude -p (fresh context, reads transcript tail)
// - Fallback: minimal bridge from journal.why if claude -p fails
//
// Shorter claude -p timeout than PreCompact (10s vs 30s) — SessionEnd delays
// process exit, so we keep it tight.
//
// Silent-fail on all errors — must never block session exit.

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  getClaudeDir,
  getInstanceTag,
  getJournalPath,
  readJournal,
  getCtxBridgePath,
  findLatestJsonl,
  readLastUsage,
  readCtxBridge,
  writeCtxBridge,
  CONTEXT_WINDOW,
  CLAUDE_BIN,
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
  const journalPath = getJournalPath(claudeDir, instanceTag);
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

  // Write bridge only if none exists. Existing bridge (tracker at ≥74% or
  // PreCompact) is richer — preserve it.
  const bridgePath = getCtxBridgePath(claudeDir);
  if (!readCtxBridge(bridgePath)) {
    const transcriptPath = resolveTranscript(rawInput, claudeDir);
    const written = transcriptPath && tryWriteAiBridge(bridgePath, transcriptPath, usedPct);
    if (!written && why) {
      // Fallback: minimal bridge from journal.why
      writeCtxBridge(bridgePath, {
        files: [],
        next:  why,
        err:   null,
        pct:   usedPct !== null ? Math.round(usedPct) : null,
        at:    new Date().toISOString(),
      });
    }
  }

  process.exit(0);
}

// Resolve transcript: prefer stdin transcript_path, fallback to findLatestJsonl.
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

// Spawn `claude -p` with transcript tail as stdin. Parse JSON, write bridge.
// Returns true on success, false on any failure.
function tryWriteAiBridge(bridgePath, transcriptPath, usedPct) {
  try {
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
      timeout:  10000,  // 10s — shorter than PreCompact to minimize exit delay
    });

    if (result.status !== 0 || !result.stdout) return false;

    const extracted = parseJsonOutput(result.stdout);
    if (!extracted || typeof extracted.next !== 'string') return false;

    writeCtxBridge(bridgePath, {
      files: Array.isArray(extracted.files) ? extracted.files : [],
      next:  extracted.next,
      err:   extracted.err || null,
      pct:   usedPct !== null ? Math.round(usedPct) : null,
      at:    new Date().toISOString(),
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Parse JSON from claude output — handles whitespace and markdown fences.
function parseJsonOutput(output) {
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch (e) {}
    }
  }
  const stripped = output.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();
  try { return JSON.parse(stripped); } catch (e) {}
  return null;
}
