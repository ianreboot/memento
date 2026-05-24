#!/usr/bin/env node
// memento — journal write helper (v0.6.0)
//
// Invoked by Claude to write the journal without requiring a prior Read tool call.
// Usage: node memento-write-why.js '<why string>'
//
// Takes a single CLI argument: the new why value (plain string, max 200 chars).
// Reads the existing journal, manages why_history, writes atomically via writeJournal().
// Exit 0 always. No stdout output. Silent-fail on any error.
//
// Security: routes all writes through writeJournal() — atomic temp+rename, symlink-safe.
// This is the fix for KNOWN_ISSUES.md #2 (Write tool path bypasses atomic protections).

'use strict';

const {
  getInstanceTag,
  getProjectHash,
  getClaudeDir,
  getJournalPath,
  readJournal,
  writeJournal,
} = require('./memento-config');

try {
  const newWhy = (process.argv[2] || '').trim();
  if (!newWhy) process.exit(0); // No why provided — silent noop

  const claudeDir   = getClaudeDir();
  const instanceTag = getInstanceTag();
  const projectHash = getProjectHash();
  const journalPath = getJournalPath(claudeDir, instanceTag, projectHash);

  const existing    = readJournal(journalPath);
  const prevWhy     = existing && typeof existing.why === 'string' ? existing.why : null;
  const prevWhen    = existing && existing.when ? existing.when : null;
  const prevHistory = existing && Array.isArray(existing.why_history) ? existing.why_history : [];

  // Only append to history when why changes value (not on same-value rewrites).
  // writeJournal's normalizeJournal caps history at MAX_WHY_HISTORY automatically.
  let history = prevHistory;
  if (prevWhy !== null && prevWhy !== newWhy) {
    history = [...prevHistory, { w: prevWhy, t: prevWhen || new Date().toISOString() }];
  }

  writeJournal(journalPath, {
    why:         newWhy,
    when:        new Date().toISOString(),
    why_history: history,
  });

  process.exit(0);
} catch (e) {
  // Silent fail — never block Claude's response
  process.exit(0);
}
