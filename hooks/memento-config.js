#!/usr/bin/env node
// memento — shared configuration and journal utilities (v0.4.0)
//
// Handles:
//   - Instance tag derivation (which journal file to use; one file per OS user)
//   - Journal file path resolution
//   - Safe atomic reads and writes (symlink-safe, size-capped)
//   - Turn counter sidecar path (for T1 vs T2+ discrimination)
//
// v0.4.0 schema: { why, when, why_history }
// Previous schema (mission/done/plan/wip) removed. Old journal files without
// a 'why' field are treated as non-existent — the Turn 1 / No Journal prompt
// fires and Claude creates a fresh journal at the same path.
//
// Design principles:
//   - Silent-fail on all filesystem errors — never block Claude Code
//   - Atomic writes via temp-file + rename — no mid-write corruption on crash
//   - Symlink-safe I/O — protects against symlink-clobber attack
//   - No external dependencies — only Node.js built-ins
//
// Security note on symlink safety:
//   The journal file lives at a predictable path. Without protection, a local
//   attacker could replace it with a symlink to a sensitive file. We defend
//   against this by checking lstat() before every open, refusing symlinks at
//   both the file and parent-directory level (with the exception of trusted
//   symlinked ~/.claude dirs).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Maximum journal file size. With why (200ch) + why_history (10 × 200ch each)
// the serialized size is well under 4KB. 6KB cap maintained for safety headroom.
const MAX_JOURNAL_BYTES = parseInt(process.env.MEMENTO_MAX_FILE_KB || '', 10) * 1024 || 6 * 1024;

// Why field max length in characters.
const MAX_WHY_CHARS = 200;

// Rolling why_history cap. Oldest entries are dropped when exceeded.
const MAX_WHY_HISTORY = 10;

// Working directory names that provide no useful project identity.
const TAG_BLOCKLIST = new Set([
  'workspace', 'tmp', 'temp', 'home', 'root', 'user', 'ubuntu',
  'claude', 'projects', '', '/', '.',
]);

const DEBUG = process.env.MEMENTO_DEBUG === '1';

// ---------------------------------------------------------------------------
// Instance tag derivation (used for journal FILE PATH)
// ---------------------------------------------------------------------------

// Derive the instance tag used as the journal filename stem.
// Per-instance design: one journal per Claude docker container.
//
// Resolution order:
//   1. MEMENTO_INSTANCE_TAG env var — explicit override
//   2. OS username (os.userInfo().username)
//   3. "default" — fallback
function getInstanceTag() {
  const envTag = process.env.MEMENTO_INSTANCE_TAG;
  if (envTag) {
    const normalized = normalize(envTag);
    if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
  }
  try {
    const username = os.userInfo().username;
    if (username) {
      const normalized = normalize(username);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* fall through */ }
  return 'default';
}

// Derive the current project from the git repo root or cwd basename.
// Informational only — v0.4.0 does not store project in the journal.
function getProjectTag() {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    const name = path.basename(gitRoot);
    if (name) {
      const normalized = normalize(name);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* not in a git repo */ }
  try {
    const cwdName = path.basename(process.cwd());
    if (cwdName) {
      const normalized = normalize(cwdName);
      if (normalized && !TAG_BLOCKLIST.has(normalized)) return normalized;
    }
  } catch (e) { /* fall through */ }
  return 'default';
}

function normalize(tag) {
  const result = tag.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  return result || 'default';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Returns the path to the ~/.claude directory (or $CLAUDE_CONFIG_DIR).
function getClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Returns the path to the journal file for a given instance tag.
// Creates the .memento directory if needed (silent-fail).
function getJournalPath(claudeDir, instanceTag) {
  const dir = path.join(claudeDir, '.memento');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* silent */ }
  return path.join(dir, `${instanceTag}.json`);
}

// Returns the path to the turn counter sidecar file.
// The sidecar stores the current turn number as a plain integer string.
// SessionStart resets it to 0; UserPromptSubmit increments it each turn.
// This enables T1 vs T2+ discrimination without reading the journal.
function getTurnSidecarPath(journalPath) {
  return journalPath.replace(/\.json$/, '.turn');
}

// ---------------------------------------------------------------------------
// Safe journal read
// ---------------------------------------------------------------------------

// Read and parse the journal file.
// Returns the parsed object if it's a valid v0.4.0 journal (has a 'why' field),
// or null if:
//   - File is missing (normal on first run)
//   - File is a symlink or not a regular file
//   - File exceeds MAX_JOURNAL_BYTES
//   - File contains invalid JSON
//   - File is a pre-v0.4.0 journal (no 'why' field) — treated as non-existent
function readJournal(journalPath) {
  try {
    let st;
    try {
      st = fs.lstatSync(journalPath);
    } catch (e) {
      return null; // File doesn't exist — normal on first run
    }

    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > MAX_JOURNAL_BYTES) return null;

    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW : 0;
    let fd;
    let raw;
    try {
      fd = fs.openSync(journalPath, fs.constants.O_RDONLY | O_NOFOLLOW);
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* silent */ }
    }

    const journal = JSON.parse(raw);
    if (typeof journal !== 'object' || journal === null) return null;

    // v0.4.0 schema: 'why' field must be present.
    // Pre-v0.4.0 journals (mission/done/plan schema) are treated as non-existent.
    if (!('why' in journal)) return null;
    if (journal.why !== null && typeof journal.why !== 'string') return null;
    if (journal.why_history !== undefined && !Array.isArray(journal.why_history)) return null;

    return journal;
  } catch (e) {
    return null; // Corrupt or unreadable — treat as missing
  }
}

// ---------------------------------------------------------------------------
// Journal normalization
// ---------------------------------------------------------------------------

// Collapse newlines to spaces so injected text stays on one line per field.
function sanitizeLine(s) {
  return s.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Normalize journal data before writing. Enforces field limits and why_history cap.
function normalizeJournal(data) {
  const j = {};

  // why: string or null; truncated to MAX_WHY_CHARS
  if (typeof data.why === 'string') {
    j.why = sanitizeLine(data.why.slice(0, MAX_WHY_CHARS)) || null;
  } else {
    j.why = null;
  }

  // when: ISO 8601 string; defaults to now if absent or wrong type
  j.when = typeof data.when === 'string' ? data.when : new Date().toISOString();

  // why_history: array of {w, t} objects; drop oldest when over cap
  const history = Array.isArray(data.why_history) ? data.why_history : [];
  j.why_history = history
    .filter(e => e && typeof e.w === 'string')
    .slice(-MAX_WHY_HISTORY)
    .map(e => ({
      w: sanitizeLine(String(e.w).slice(0, MAX_WHY_CHARS)),
      t: String(e.t || ''),
    }));

  return j;
}

// ---------------------------------------------------------------------------
// Safe journal write (atomic, symlink-safe)
// ---------------------------------------------------------------------------

// Write the journal object atomically.
//
// Steps:
//   1. Normalize fields (truncate why, cap why_history)
//   2. Serialize to JSON
//   3. Write to temp file (unique name, pid + timestamp)
//   4. Set permissions to 0600
//   5. rename() temp → target (atomic on POSIX)
//
// Symlink safety: refuses to write if the target path or its parent directory
// is a symlink pointing to a location owned by a different user.
// Silent-fails on any filesystem error.
function writeJournal(journalPath, data) {
  let tempPath;
  try {
    const journalDir  = path.dirname(journalPath);
    const journalBase = path.basename(journalPath);

    fs.mkdirSync(journalDir, { recursive: true });

    // Resolve parent directory — allow legitimate symlinked ~/.claude dirs
    // but refuse attacker-planted symlinks pointing at dirs owned by another user
    let realDir;
    try {
      const lstat = fs.lstatSync(journalDir);
      if (lstat.isSymbolicLink()) {
        realDir = fs.realpathSync(journalDir);
        const realStat = fs.statSync(realDir);
        if (!realStat.isDirectory()) return;
        if (typeof process.getuid === 'function') {
          if (realStat.uid !== process.getuid()) return;
        } else {
          const normalizedReal = path.resolve(realDir).toLowerCase();
          const normalizedHome = path.resolve(os.homedir()).toLowerCase();
          if (!normalizedReal.startsWith(normalizedHome + path.sep) && normalizedReal !== normalizedHome) return;
        }
      } else {
        realDir = journalDir;
      }
    } catch (e) {
      return;
    }

    // The journal file itself must not be a symlink (the actual clobber vector)
    const realJournalPath = path.join(realDir, journalBase);
    try {
      if (fs.lstatSync(realJournalPath).isSymbolicLink()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') return;
    }

    const safe = normalizeJournal(data);
    const json = JSON.stringify(safe, null, 2);
    if (Buffer.byteLength(json, 'utf8') > MAX_JOURNAL_BYTES) return; // too large — abort

    // Atomic write: temp file → rename
    tempPath = path.join(realDir, `.memento-${path.basename(journalBase, '.json')}.${process.pid}.${Date.now()}.tmp`);
    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const openFlags  = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(tempPath, openFlags, 0o600);
      fs.writeSync(fd, json);
      try { fs.fchmodSync(fd, 0o600); } catch (e) { /* best-effort on Windows */ }
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* silent */ }
    }
    fs.renameSync(tempPath, realJournalPath);

  } catch (e) {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
    if (DEBUG) process.stderr.write(`[memento] writeJournal error: ${e.message}\n`);
    // Silent fail — journal is best-effort
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getInstanceTag,
  getProjectTag,
  getClaudeDir,
  getJournalPath,
  getTurnSidecarPath,
  sanitizeLine,
  readJournal,
  writeJournal,
  DEBUG,
  MAX_WHY_CHARS,
  MAX_WHY_HISTORY,
  MAX_JOURNAL_BYTES,
};
