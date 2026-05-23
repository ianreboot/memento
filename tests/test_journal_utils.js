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
  getLastCtxPath,
  readLastCtxPct,
  writeLastCtxPct,
  sanitizeLine,
  readJournal,
  writeJournal,
  getCtxBridgePath,
  writeCtxBridge,
  readCtxBridge,
  deleteCtxBridge,
  readLastUsage,
  findLatestJsonl,
  MAX_WHY_CHARS,
  MAX_WHY_HISTORY,
  MAX_BRIDGE_NEXT_CHARS,
  MAX_BRIDGE_FILES,
  CTX_DROP_THRESHOLD,
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
// ctx_bridge helpers
// ---------------------------------------------------------------------------

console.log('\nctx_bridge helpers');

test('getCtxBridgePath returns {claudeDir}/.memento/ctx_bridge.json', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  assert.strictEqual(p, path.join(dir, '.memento', 'ctx_bridge.json'));
});

test('writeCtxBridge + readCtxBridge round-trip (valid data)', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  const data = { files: ['/foo.js', '/bar.js'], next: 'run tests', err: null, pct: 74, at: '2026-05-23T00:00:00Z' };
  writeCtxBridge(p, data);
  const result = readCtxBridge(p);
  assert.ok(result !== null, 'must read back written bridge');
  assert.deepStrictEqual(result.files, data.files);
  assert.strictEqual(result.next, data.next);
  assert.strictEqual(result.err, data.err);
  assert.strictEqual(result.pct, data.pct);
});

test('readCtxBridge returns null for missing file', () => {
  const dir = tmpDir();
  const p = path.join(dir, '.memento', 'ctx_bridge.json');
  assert.strictEqual(readCtxBridge(p), null);
});

test('readCtxBridge returns null for symlink', () => {
  const dir = tmpDir();
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const real = path.join(mementoDir, 'real.json');
  const link = path.join(mementoDir, 'ctx_bridge.json');
  fs.writeFileSync(real, JSON.stringify({ files: [], next: 'ok', err: null, pct: 74, at: '2026-05-23T00:00:00Z' }));
  try { fs.symlinkSync(real, link); } catch (e) { return; }
  assert.strictEqual(readCtxBridge(link), null, 'symlink must return null');
});

test('readCtxBridge returns null for invalid JSON', () => {
  const dir = tmpDir();
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const p = path.join(mementoDir, 'ctx_bridge.json');
  fs.writeFileSync(p, 'not json');
  assert.strictEqual(readCtxBridge(p), null);
});

test('readCtxBridge returns null if files field missing', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ next: 'ok', err: null, pct: 74, at: '2026-05-23T00:00:00Z' }));
  assert.strictEqual(readCtxBridge(p), null, 'missing files field must return null');
});

test('readCtxBridge returns null if next field missing', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ files: [], err: null, pct: 74, at: '2026-05-23T00:00:00Z' }));
  assert.strictEqual(readCtxBridge(p), null, 'missing next field must return null');
});

test('readCtxBridge returns object without truncation (normalization is write-side only)', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  const longNext = 'a'.repeat(500);
  writeCtxBridge(p, { files: [], next: longNext, err: null, pct: 74, at: '2026-05-23T00:00:00Z' });
  const result = readCtxBridge(p);
  // Write side truncates to MAX_BRIDGE_NEXT_CHARS — read side returns as-is
  assert.ok(result !== null);
  assert.strictEqual(result.next.length, MAX_BRIDGE_NEXT_CHARS, 'truncated at write time, not read time');
});

test('readCtxBridge returns object even without pct field (pct is optional)', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ files: ['/a.js'], next: 'resume', err: null, at: '2026-05-23T00:00:00Z' }));
  const result = readCtxBridge(p);
  assert.ok(result !== null, 'bridge without pct field must still be valid');
  assert.strictEqual(result.pct, undefined);
});

test('writeCtxBridge truncates next to MAX_BRIDGE_NEXT_CHARS at write time', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  writeCtxBridge(p, { files: [], next: 'x'.repeat(MAX_BRIDGE_NEXT_CHARS + 100), err: null, pct: 74, at: '2026-05-23T00:00:00Z' });
  const result = readCtxBridge(p);
  assert.ok(result !== null);
  assert.ok(result.next.length <= MAX_BRIDGE_NEXT_CHARS);
});

test('writeCtxBridge caps files to MAX_BRIDGE_FILES entries at write time', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  const files = ['/a.js', '/b.js', '/c.js', '/d.js', '/e.js', '/f.js', '/g.js'];
  writeCtxBridge(p, { files, next: 'test', err: null, pct: 74, at: '2026-05-23T00:00:00Z' });
  const result = readCtxBridge(p);
  assert.ok(result !== null);
  assert.ok(result.files.length <= MAX_BRIDGE_FILES);
});

test('deleteCtxBridge removes file, returns silently on missing', () => {
  const dir = tmpDir();
  const p = getCtxBridgePath(dir);
  writeCtxBridge(p, { files: [], next: 'test', err: null, pct: 74, at: '2026-05-23T00:00:00Z' });
  assert.ok(fs.existsSync(p), 'file must exist before delete');
  deleteCtxBridge(p);
  assert.ok(!fs.existsSync(p), 'file must be gone after delete');
  // Second call on missing file must not throw
  assert.doesNotThrow(() => deleteCtxBridge(p));
});

// ---------------------------------------------------------------------------
// last_ctx helpers
// ---------------------------------------------------------------------------

console.log('\nlast_ctx helpers');

test('getLastCtxPath returns .last_ctx path alongside .json', () => {
  const journalPath = '/some/dir/.memento/alice.json';
  assert.strictEqual(getLastCtxPath(journalPath), '/some/dir/.memento/alice.last_ctx');
});

test('readLastCtxPct returns null for missing file', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'missing.last_ctx');
  assert.strictEqual(readLastCtxPct(p), null);
});

test('readLastCtxPct returns null for invalid content', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad.last_ctx');
  fs.writeFileSync(p, 'not a number');
  assert.strictEqual(readLastCtxPct(p), null);
});

test('readLastCtxPct returns float from valid file', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'valid.last_ctx');
  fs.writeFileSync(p, '78.5');
  const val = readLastCtxPct(p);
  assert.ok(val !== null, 'must return value');
  assert.ok(Math.abs(val - 78.5) < 0.001, `expected 78.5, got ${val}`);
});

test('writeLastCtxPct + readLastCtxPct round-trip', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const p = getLastCtxPath(journalPath);
  writeLastCtxPct(p, 65.3);
  const val = readLastCtxPct(p);
  assert.ok(val !== null, 'must read back written value');
  assert.ok(Math.abs(val - 65.3) < 0.001, `expected 65.3, got ${val}`);
});

test('writeLastCtxPct creates file with 0600 permissions', () => {
  const dir = tmpDir();
  const journalPath = getJournalPath(dir, 'testuser');
  const p = getLastCtxPath(journalPath);
  writeLastCtxPct(p, 42.0);
  const stat = fs.statSync(p);
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `permissions must be 0600, got 0${mode.toString(8)}`);
});

test('CTX_DROP_THRESHOLD is a number >= 10', () => {
  assert.ok(typeof CTX_DROP_THRESHOLD === 'number', 'must be a number');
  assert.ok(CTX_DROP_THRESHOLD >= 10, `must be >= 10, got ${CTX_DROP_THRESHOLD}`);
});

// ---------------------------------------------------------------------------
// readLastUsage
// ---------------------------------------------------------------------------

console.log('\nreadLastUsage');

const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'sample-session.jsonl');

test('readLastUsage returns correct usage from fixture JSONL', () => {
  const usage = readLastUsage(FIXTURE_JSONL);
  assert.ok(usage !== null, 'must return usage object');
  // Last turn: input=1, cache_read=99000, cache_write=57000 → total 156001 ~ 78%
  assert.strictEqual(usage.input_tokens, 1);
  assert.strictEqual(usage.cache_read_input_tokens, 99000);
  assert.strictEqual(usage.cache_creation_input_tokens, 57000);
});

test('readLastUsage returns null for missing file', () => {
  assert.strictEqual(readLastUsage('/nonexistent/path.jsonl'), null);
});

test('readLastUsage returns null for empty file', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(p, '');
  assert.strictEqual(readLastUsage(p), null);
});

test('readLastUsage handles JSONL with a line longer than 16KB', () => {
  // The fixture has a line with 17KB of padding — readLastUsage must still find last usage
  const usage = readLastUsage(FIXTURE_JSONL);
  assert.ok(usage !== null, 'must handle lines > 16KB');
  // Must return the LAST usage (turn 3), not turn 2
  assert.strictEqual(usage.cache_creation_input_tokens, 57000, 'must return last usage, not the large-line turn');
});

// ---------------------------------------------------------------------------
// findLatestJsonl
// ---------------------------------------------------------------------------

console.log('\nfindLatestJsonl');

test('findLatestJsonl returns most-recently-modified JSONL from projects dir structure', () => {
  const dir = tmpDir();
  const projDir = path.join(dir, 'projects', 'abc123');
  fs.mkdirSync(projDir, { recursive: true });
  const p = path.join(projDir, 'session.jsonl');
  fs.writeFileSync(p, '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1}}}');
  // Use current time so it's within 5-min window
  const result = findLatestJsonl(dir);
  assert.strictEqual(result, p);
});

test('findLatestJsonl returns null when no JSONL files exist', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  assert.strictEqual(findLatestJsonl(dir), null);
});

test('findLatestJsonl returns null when projects dir does not exist', () => {
  const dir = tmpDir();
  assert.strictEqual(findLatestJsonl(dir), null);
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
