#!/usr/bin/env node
// Unit tests for memento-config.js journal utilities
'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  getInstanceTag,
  getJournalPath,
  readJournal,
  writeJournal,
  pruneJournal,
  formatJournalForInjection,
  newJournal,
  MAX_COMPLETED,
  MAX_UPCOMING,
  MAX_SUMMARY_CHARS,
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
  // 'workspace' is blocklisted — should fall through to OS username or 'default'
  assert.notStrictEqual(tag, 'workspace', 'blocklisted override must be ignored');
});

// ---------------------------------------------------------------------------
// pruneJournal
// ---------------------------------------------------------------------------

console.log('\npruneJournal');

test('null input returns null', () => {
  assert.strictEqual(pruneJournal(null), null);
});

test('rolling window: entry 9 is folded into summary', () => {
  const j = newJournal('test mission', 'testproj');
  for (let i = 0; i < MAX_COMPLETED + 1; i++) {
    j.completed.push({ task: `task-${i}`, result: `result-${i}`, ts: new Date().toISOString() });
  }
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.completed.length, MAX_COMPLETED);
  assert.ok(pruned.summary && pruned.summary.length > 0, 'summary must be set after fold');
  assert.ok(pruned.summary.includes('task-0'), 'oldest entry (task-0) must be in summary');
  assert.ok(!pruned.summary.includes('task-8'), 'newest entry must stay in completed, not summary');
});

test('rolling window: summary stays within MAX_SUMMARY_CHARS', () => {
  const j = newJournal('test', 'test');
  j.summary = 'x'.repeat(MAX_SUMMARY_CHARS - 5);
  for (let i = 0; i < MAX_COMPLETED + 1; i++) {
    j.completed.push({ task: `task-${i}`, result: `r`, ts: new Date().toISOString() });
  }
  const pruned = pruneJournal(j);
  assert.ok(
    pruned.summary.length <= MAX_SUMMARY_CHARS,
    `summary length ${pruned.summary.length} must be <= ${MAX_SUMMARY_CHARS}`
  );
});

test('stale collapse: clears completed + upcoming, sets mission_closed', () => {
  const j = newJournal('stale mission', 'staleproj');
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago (active missions collapse at STALE_DAYS*2=14d)
  j.completed = [{ task: 'old task', result: 'done', ts: oldDate }];
  j.upcoming  = ['pending thing'];
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.completed.length, 0, 'completed must be cleared');
  assert.strictEqual(pruned.upcoming.length, 0, 'upcoming must be cleared');
  assert.ok(pruned.mission_closed, 'mission_closed must be set');
  assert.ok(pruned.summary && pruned.summary.includes('old task'), 'collapsed task must appear in summary');
});

test('stale collapse: already-closed mission stays closed', () => {
  const j = newJournal('stale mission', 'staleproj');
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  j.completed     = [{ task: 'old task', result: 'done', ts: oldDate }];
  j.mission_closed = oldDate;
  const pruned = pruneJournal(j);
  assert.ok(pruned.mission_closed, 'mission_closed must remain set');
});

test('upcoming array capped at MAX_UPCOMING', () => {
  const j = newJournal('test', 'test');
  for (let i = 0; i < MAX_UPCOMING + 5; i++) j.upcoming.push(`task ${i}`);
  const pruned = pruneJournal(j);
  assert.ok(pruned.upcoming.length <= MAX_UPCOMING);
});

test('fresh journal with no entries is returned unchanged', () => {
  const j = newJournal('fresh', 'fresh');
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.completed.length, 0);
  assert.strictEqual(pruned.upcoming.length, 0);
});

// ---------------------------------------------------------------------------
// formatJournalForInjection
// ---------------------------------------------------------------------------

console.log('\nformatJournalForInjection');

test('brief: includes [MEMENTO] header + count line', () => {
  const j = newJournal('build something', 'myproj');
  j.completed = [{ task: 'done task', result: 'ok', ts: new Date().toISOString() }];
  j.upcoming  = ['next task'];
  const out = formatJournalForInjection(j, 'brief', '/tmp/test.json');
  assert.ok(out.includes('[MEMENTO]'), 'must include [MEMENTO] marker');
  assert.ok(out.includes('build something'), 'must include mission text');
  assert.ok(out.includes('1 task(s) done'), 'must include done count');
  assert.ok(out.includes('1 pending'), 'must include pending count');
  assert.ok(!out.includes('Done:'), 'brief mode must NOT include Done: lines');
});

test('full: includes Done: and Next: lines', () => {
  const j = newJournal('build something', 'myproj');
  j.completed = [{ task: 'fix auth', result: 'PASETO impl', ts: new Date().toISOString() }];
  j.upcoming  = ['deploy'];
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('Done: fix auth'), 'must include Done: line');
  assert.ok(out.includes('-> PASETO impl'), 'must include result after ->');
  assert.ok(out.includes('Next: deploy'), 'must include Next: line');
});

test('full: includes ctx field when present', () => {
  const j = newJournal('test', 'test');
  j.completed = [{ task: 'analyze', result: 'found bug', ctx: 'user said it was broken', ts: new Date().toISOString() }];
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('| ctx: user said it was broken'), 'must include ctx field');
});

test('full: shows BLOCKED state mark', () => {
  const j = newJournal('blocked mission', 'myproj');
  j.state       = 'blocked';
  j.state_reason = 'waiting on API key';
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('[BLOCKED'), 'must show [BLOCKED state mark');
  assert.ok(out.includes('waiting on API key'), 'must include state_reason');
});

test('full: shows WAITING state mark', () => {
  const j = newJournal('waiting mission', 'myproj');
  j.state = 'waiting';
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('[WAITING]'), 'must show [WAITING] mark');
});

test('full: shows WIP line when in_progress is set', () => {
  const j = newJournal('wip mission', 'myproj');
  j.in_progress = { task: 'running analysis', started: new Date().toISOString(), progress: '3/10 done' };
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('WIP: running analysis'), 'must include WIP line');
  assert.ok(out.includes('3/10 done'), 'must include progress text');
});

test('full: includes journal path in header', () => {
  const j   = newJournal('path test', 'myproj');
  const out = formatJournalForInjection(j, 'full', '/home/user/.claude/.memento/testuser.json');
  assert.ok(out.includes('path:/home/user/.claude/.memento/testuser.json'), 'must include file path');
});

test('null journal returns empty string', () => {
  assert.strictEqual(formatJournalForInjection(null, 'full', '/tmp/test.json'), '');
});

// ---------------------------------------------------------------------------
// writeJournal + readJournal
// ---------------------------------------------------------------------------

console.log('\nwriteJournal + readJournal');

test('round-trip: write then read returns equivalent data', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('round trip test', 'testproj');
    j.completed = [{ task: 'test task', result: 'ok', ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded !== null, 'readJournal must return non-null after write');
    assert.strictEqual(loaded.mission, 'round trip test');
    assert.strictEqual(loaded.completed.length, 1);
    assert.strictEqual(loaded.completed[0].task, 'test task');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal creates file with 0600 permissions', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    writeJournal(journalPath, newJournal('perm test', 'test'));
    const mode = fs.statSync(journalPath).mode & 0o777;
    assert.strictEqual(mode & 0o077, 0, `group/world bits must be 0, got 0o${mode.toString(8)}`);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal truncates overlong task field to 80 chars', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('trunc test', 'test');
    j.completed = [{ task: 'x'.repeat(200), result: 'ok', ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.completed[0].task.length <= 80, 'task must be capped at 80 chars');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal truncates overlong result field to 120 chars', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('trunc test', 'test');
    j.completed = [{ task: 'a task', result: 'y'.repeat(200), ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.completed[0].result.length <= 120, 'result must be capped at 120 chars');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal preserves absent ctx as absent (not coerced to empty string)', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('ctx test', 'test');
    j.completed = [{ task: 'task without ctx', result: 'ok', ts: new Date().toISOString() }]; // no ctx field
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(!('ctx' in loaded.completed[0]), 'absent ctx must remain absent after round-trip');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('readJournal returns null for missing file', () => {
  assert.strictEqual(readJournal(`/tmp/nonexistent-${Date.now()}.json`), null);
});

test('readJournal returns null for invalid JSON', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'bad.json');
    fs.writeFileSync(journalPath, 'not json {{{broken');
    assert.strictEqual(readJournal(journalPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('readJournal returns null when mission field is missing', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'bad.json');
    fs.writeFileSync(journalPath, JSON.stringify({ completed: [], upcoming: [] })); // no mission
    assert.strictEqual(readJournal(journalPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failed > 0) {
  console.error(`${passed} passed, ${failed} failed`);
  process.exit(1);
} else {
  console.log(`${passed} passed`);
}
