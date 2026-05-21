#!/usr/bin/env node
// Unit tests for memento-config.js (v0.4.0)
'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  getInstanceTag,
  getJournalPath,
  getTurnSidecarPath,
  sanitizeLine,
  readJournal,
  writeJournal,
  MAX_WHY_CHARS,
  MAX_WHY_HISTORY,
} = require('../hooks/memento-config.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    if (process.env.MEMENTO_TEST_VERBOSE) console.error(e.stack);
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memento-utils-'));
}

// ---------------------------------------------------------------------------
// getInstanceTag
// ---------------------------------------------------------------------------

console.log('\ngetInstanceTag');

test('returns non-empty string by default', () => {
  const tag = getInstanceTag();
  assert.ok(typeof tag === 'string' && tag.length > 0, 'must be non-empty string');
});

test('respects MEMENTO_INSTANCE_TAG env override', () => {
  process.env.MEMENTO_INSTANCE_TAG = 'testinstance';
  const tag = getInstanceTag();
  delete process.env.MEMENTO_INSTANCE_TAG;
  assert.strictEqual(tag, 'testinstance');
});

test('ignores blocklisted MEMENTO_INSTANCE_TAG values', () => {
  process.env.MEMENTO_INSTANCE_TAG = 'workspace';
  const tag = getInstanceTag();
  delete process.env.MEMENTO_INSTANCE_TAG;
  assert.notStrictEqual(tag, 'workspace', 'blocklisted override must be ignored');
});

// ---------------------------------------------------------------------------
// getTurnSidecarPath
// ---------------------------------------------------------------------------

console.log('\ngetTurnSidecarPath');

test('returns .turn path alongside .json path', () => {
  const journalPath = '/some/dir/.memento/alice.json';
  const sidecarPath = getTurnSidecarPath(journalPath);
  assert.strictEqual(sidecarPath, '/some/dir/.memento/alice.turn');
});

test('handles paths without .json extension gracefully', () => {
  const journalPath = '/some/dir/.memento/alice';
  const sidecarPath = getTurnSidecarPath(journalPath);
  // Should not crash — result just has .turn appended differently
  assert.ok(typeof sidecarPath === 'string');
});

// ---------------------------------------------------------------------------
// sanitizeLine
// ---------------------------------------------------------------------------

console.log('\nsanitizeLine');

test('collapses newlines to spaces', () => {
  assert.strictEqual(sanitizeLine('hello\nworld'), 'hello world');
  assert.strictEqual(sanitizeLine('hello\r\nworld'), 'hello world');
});

test('collapses multiple spaces', () => {
  assert.strictEqual(sanitizeLine('hello   world'), 'hello world');
});

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(sanitizeLine('  hello  '), 'hello');
});

test('passes through normal text unchanged', () => {
  assert.strictEqual(sanitizeLine('fixing auth for mobile'), 'fixing auth for mobile');
});

// ---------------------------------------------------------------------------
// readJournal
// ---------------------------------------------------------------------------

console.log('\nreadJournal');

test('returns null for missing file', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'missing.json');
  assert.strictEqual(readJournal(p), null);
});

test('returns null for invalid JSON', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, 'not json');
  assert.strictEqual(readJournal(p), null);
});

test('returns null for old-schema journal (no why field)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'old.json');
  fs.writeFileSync(p, JSON.stringify({
    mission: 'old mission',
    mission_opened: new Date().toISOString(),
    mission_closed: null,
    project: 'myapp',
    done: [],
    plan: [],
  }, null, 2));
  assert.strictEqual(readJournal(p), null, 'pre-v0.4.0 journal (no why) must return null');
});

test('returns object for valid v0.4.0 journal', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'valid.json');
  const journal = { why: 'fixing auth', when: '2026-05-21T14:00:00Z', why_history: [] };
  fs.writeFileSync(p, JSON.stringify(journal, null, 2));
  const result = readJournal(p);
  assert.ok(result !== null, 'valid v0.4.0 journal must be returned');
  assert.strictEqual(result.why, 'fixing auth');
});

test('returns object for journal with null why (no prior write)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'null-why.json');
  const journal = { why: null, when: '2026-05-21T14:00:00Z', why_history: [] };
  fs.writeFileSync(p, JSON.stringify(journal, null, 2));
  const result = readJournal(p);
  assert.ok(result !== null, 'journal with null why must be returned (field present)');
  assert.strictEqual(result.why, null);
});

test('returns null if why is wrong type (not string or null)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad-why.json');
  fs.writeFileSync(p, JSON.stringify({ why: 42, when: '2026-05-21T14:00:00Z', why_history: [] }));
  assert.strictEqual(readJournal(p), null);
});

test('returns null if why_history is wrong type', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad-hist.json');
  fs.writeFileSync(p, JSON.stringify({ why: 'ok', when: '2026-05-21T14:00:00Z', why_history: 'bad' }));
  assert.strictEqual(readJournal(p), null);
});

test('returns null for symlink at journal path', () => {
  const dir = tmpDir();
  const realFile = path.join(dir, 'real.json');
  const linkFile = path.join(dir, 'link.json');
  fs.writeFileSync(realFile, JSON.stringify({ why: 'auth', when: '2026-05-21T14:00:00Z', why_history: [] }));
  try { fs.symlinkSync(realFile, linkFile); } catch (e) { return; } // skip if no symlink support
  assert.strictEqual(readJournal(linkFile), null, 'symlink at journal path must return null');
});

// ---------------------------------------------------------------------------
// writeJournal + readJournal roundtrip
// ---------------------------------------------------------------------------

console.log('\nwriteJournal + readJournal');

test('round-trip: write then read returns equivalent data', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const data = {
    why: 'fixing auth for mobile',
    when: '2026-05-21T14:00:00Z',
    why_history: [{ w: 'setup project', t: '2026-05-21T12:00:00Z' }],
  };
  writeJournal(journalPath, data);
  const result = readJournal(journalPath);
  assert.ok(result !== null, 'written journal must be readable');
  assert.strictEqual(result.why, data.why);
  assert.strictEqual(result.when, data.when);
  assert.deepStrictEqual(result.why_history, data.why_history);
});

test('writeJournal creates file with 0600 permissions', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  writeJournal(journalPath, { why: 'test', when: new Date().toISOString(), why_history: [] });
  const stat = fs.statSync(journalPath);
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `permissions must be 0600, got ${mode.toString(8)}`);
});

test('writeJournal truncates overlong why to MAX_WHY_CHARS', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const longWhy = 'a'.repeat(MAX_WHY_CHARS + 50);
  writeJournal(journalPath, { why: longWhy, when: new Date().toISOString(), why_history: [] });
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  assert.ok(result.why.length <= MAX_WHY_CHARS, `why must be <= ${MAX_WHY_CHARS} chars`);
});

test('writeJournal caps why_history to MAX_WHY_HISTORY entries (drops oldest)', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const history = [];
  for (let i = 0; i < MAX_WHY_HISTORY + 3; i++) {
    history.push({ w: `entry-${i}`, t: '2026-05-21T00:00:00Z' });
  }
  writeJournal(journalPath, { why: 'current', when: new Date().toISOString(), why_history: history });
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  assert.strictEqual(result.why_history.length, MAX_WHY_HISTORY, `why_history must be capped at ${MAX_WHY_HISTORY}`);
  // Oldest entries (0, 1, 2) are dropped; newest (3..12) are kept
  assert.ok(!result.why_history.some(e => e.w === 'entry-0'), 'oldest entry must be dropped');
  assert.ok(result.why_history.some(e => e.w === `entry-${MAX_WHY_HISTORY + 2}`), 'newest entry must be kept');
});

test('writeJournal handles null why', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  writeJournal(journalPath, { why: null, when: new Date().toISOString(), why_history: [] });
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  assert.strictEqual(result.why, null);
});

test('writeJournal sanitizes embedded newlines in why', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  writeJournal(journalPath, { why: 'line1\nline2', when: new Date().toISOString(), why_history: [] });
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  assert.ok(!result.why.includes('\n'), 'newlines must be removed from why');
});

test('writeJournal defaults when to now if absent', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const before = Date.now();
  writeJournal(journalPath, { why: 'test' });
  const after = Date.now();
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  const whenMs = new Date(result.when).getTime();
  assert.ok(whenMs >= before && whenMs <= after + 1000, 'when should default to approximately now');
});

test('writeJournal filters invalid why_history entries (no w field)', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const history = [
    { w: 'valid', t: '2026-05-21T12:00:00Z' },
    { t: '2026-05-21T12:00:00Z' }, // missing w
    null,                            // null entry
    { w: 'also-valid', t: '2026-05-21T13:00:00Z' },
  ];
  writeJournal(journalPath, { why: 'test', when: new Date().toISOString(), why_history: history });
  const result = readJournal(journalPath);
  assert.ok(result !== null);
  assert.strictEqual(result.why_history.length, 2, 'invalid entries must be filtered out');
  assert.strictEqual(result.why_history[0].w, 'valid');
  assert.strictEqual(result.why_history[1].w, 'also-valid');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n');
if (failed > 0) {
  console.error(`${passed} passed, ${failed} failed`);
  process.exit(1);
} else {
  console.log(`${passed} passed`);
}
