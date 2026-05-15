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

test('rolling window: oldest entry is folded into summary', () => {
  const j = newJournal('test mission', 'testproj');
  for (let i = 0; i < MAX_COMPLETED + 1; i++) {
    j.done.push({ act: `task-${i}`, result: `result-${i}`, ts: new Date().toISOString() });
  }
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.done.length, MAX_COMPLETED);
  assert.ok(pruned.summary && pruned.summary.length > 0, 'summary must be set after fold');
  assert.ok(pruned.summary.includes('task-0'), 'oldest entry (task-0) must be in summary');
  assert.ok(!pruned.summary.includes(`task-${MAX_COMPLETED}`), 'newest entry must stay in done, not summary');
});

test('rolling window: summary stays within MAX_SUMMARY_CHARS', () => {
  const j = newJournal('test', 'test');
  j.summary = 'x'.repeat(MAX_SUMMARY_CHARS - 5);
  for (let i = 0; i < MAX_COMPLETED + 1; i++) {
    j.done.push({ act: `task-${i}`, result: `r`, ts: new Date().toISOString() });
  }
  const pruned = pruneJournal(j);
  assert.ok(
    pruned.summary.length <= MAX_SUMMARY_CHARS,
    `summary length ${pruned.summary.length} must be <= ${MAX_SUMMARY_CHARS}`
  );
});

test('stale collapse: clears done + plan, sets mission_closed', () => {
  const j = newJournal('stale mission', 'staleproj');
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago (active missions collapse at STALE_DAYS*2=14d)
  j.done  = [{ act: 'old task', result: 'done', ts: oldDate }];
  j.plan  = ['pending thing'];
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.done.length, 0, 'done must be cleared');
  assert.strictEqual(pruned.plan.length, 0, 'plan must be cleared');
  assert.ok(pruned.mission_closed, 'mission_closed must be set');
  assert.ok(pruned.summary && pruned.summary.includes('old task'), 'collapsed task must appear in summary');
});

test('stale collapse: already-closed mission stays closed', () => {
  const j = newJournal('stale mission', 'staleproj');
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  j.done         = [{ act: 'old task', result: 'done', ts: oldDate }];
  j.mission_closed = oldDate;
  const pruned = pruneJournal(j);
  assert.ok(pruned.mission_closed, 'mission_closed must remain set');
});

test('plan array capped at MAX_UPCOMING', () => {
  const j = newJournal('test', 'test');
  for (let i = 0; i < MAX_UPCOMING + 5; i++) j.plan.push(`task ${i}`);
  const pruned = pruneJournal(j);
  assert.ok(pruned.plan.length <= MAX_UPCOMING);
});

test('fresh journal with no entries is returned unchanged', () => {
  const j = newJournal('fresh', 'fresh');
  const pruned = pruneJournal(j);
  assert.strictEqual(pruned.done.length, 0);
  assert.strictEqual(pruned.plan.length, 0);
});

test('backward-compat: old journal with completed/upcoming normalized to done/plan', () => {
  const j = {
    mission:        'old schema journal',
    mission_opened: new Date().toISOString(),
    mission_closed: null,
    project:        'oldproj',
    summary:        null,
    state:          'active',
    state_reason:   null,
    in_progress:    null,
    completed:      [{ task: 'old task', result: 'result', ts: new Date().toISOString() }],
    upcoming:       ['next step'],
  };
  const pruned = pruneJournal(j);
  assert.ok(Array.isArray(pruned.done), 'done must be an array after normalization');
  assert.strictEqual(pruned.done.length, 1, 'one entry must survive');
  assert.ok(Array.isArray(pruned.plan), 'plan must be an array after normalization');
  assert.strictEqual(pruned.plan.length, 1, 'one plan item must survive');
  assert.ok(!('completed' in pruned), 'old completed field must be removed');
  assert.ok(!('upcoming' in pruned), 'old upcoming field must be removed');
});

test('summarizeEntries preserves ctx content in stale collapse', () => {
  const j = newJournal('ctx test', 'ctxproj');
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  j.done = [{ act: 'analyze SKU-47', result: 'margin negative', ctx: 'note: Q3 launch must hold', ts: oldDate }];
  const pruned = pruneJournal(j);
  assert.ok(pruned.summary && pruned.summary.includes('Q3 launch must hold'), 'ctx content must appear in collapsed summary');
});

// ---------------------------------------------------------------------------
// formatJournalForInjection
// ---------------------------------------------------------------------------

console.log('\nformatJournalForInjection');

test('brief: includes [MEMENTO] header + count line', () => {
  const j = newJournal('build something', 'myproj');
  j.done = [{ act: 'done task', result: 'ok', ts: new Date().toISOString() }];
  j.plan = ['next task'];
  const out = formatJournalForInjection(j, 'brief', '/tmp/test.json');
  assert.ok(out.includes('[MEMENTO]'), 'must include [MEMENTO] marker');
  assert.ok(out.includes('build something'), 'must include mission text');
  assert.ok(out.includes('1 task(s) done'), 'must include done count');
  assert.ok(out.includes('1 pending'), 'must include pending count');
  assert.ok(!out.includes('Done:'), 'brief mode must NOT include Done: lines');
});

test('brief: backward-compat with old completed/upcoming field names', () => {
  const j = {
    mission: 'old journal', mission_opened: new Date().toISOString(),
    mission_closed: null, project: 'p', summary: null,
    completed: [{ task: 'done task', result: 'ok', ts: new Date().toISOString() }],
    upcoming:  ['next task'],
  };
  const out = formatJournalForInjection(j, 'brief', '/tmp/test.json');
  assert.ok(out.includes('1 task(s) done'), 'backward-compat: must count completed as done');
  assert.ok(out.includes('1 pending'), 'backward-compat: must count upcoming as pending');
});

test('full: includes Done: and Plan: lines', () => {
  const j = newJournal('build something', 'myproj');
  j.done = [{ act: 'fix auth', result: 'PASETO impl', ts: new Date().toISOString() }];
  j.plan = ['deploy'];
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('Done: fix auth'), 'must include Done: line');
  assert.ok(out.includes('-> PASETO impl'), 'must include result after ->');
  assert.ok(out.includes('Plan: deploy'), 'must include Plan: line');
});

test('full: includes ctx field when present', () => {
  const j = newJournal('test', 'test');
  j.done = [{ act: 'analyze', result: 'found bug', ctx: 'user said it was broken', ts: new Date().toISOString() }];
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('| ctx: user said it was broken'), 'must include ctx field');
});

test('full: shows WIP line when wip string is set', () => {
  const j = newJournal('wip mission', 'myproj');
  j.wip = 'running analysis: 3/10 done';
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('WIP: running analysis'), 'must include WIP line');
  assert.ok(out.includes('3/10 done'), 'must include wip content');
});

test('full: backward-compat WIP from in_progress.progress', () => {
  const j = {
    mission: 'old wip', mission_opened: new Date().toISOString(),
    mission_closed: null, project: 'p', summary: null,
    in_progress: { task: 'deploy service', started: new Date().toISOString(), progress: 'build passed, uploading' },
    completed: [], upcoming: [],
  };
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('WIP:'), 'backward-compat: must show WIP from in_progress.progress');
  assert.ok(out.includes('build passed, uploading'), 'backward-compat: must show in_progress progress text');
});

test('full: backward-compat Done: line from old task field', () => {
  const j = {
    mission: 'old schema', mission_opened: new Date().toISOString(),
    mission_closed: null, project: 'p', summary: null,
    completed: [{ task: 'fix auth', result: 'PASETO impl', ts: new Date().toISOString() }],
    upcoming: [],
  };
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(out.includes('Done: fix auth'), 'backward-compat: must display task field as Done: act');
});

test('full: no footer paragraph in injection', () => {
  const j = newJournal('test no footer', 'myproj');
  j.done = [{ act: 'some task', result: 'done', ts: new Date().toISOString() }];
  const out = formatJournalForInjection(j, 'full', '/tmp/test.json');
  assert.ok(!out.includes('Write upcoming[]'), 'must NOT include old footer paragraph');
  assert.ok(!out.includes('set in_progress'), 'must NOT include old footer paragraph');
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
    j.done = [{ act: 'test task', result: 'ok', ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded !== null, 'readJournal must return non-null after write');
    assert.strictEqual(loaded.mission, 'round trip test');
    assert.strictEqual(loaded.done.length, 1);
    assert.strictEqual(loaded.done[0].act, 'test task');
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

test('writeJournal truncates overlong act field to 80 chars', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('trunc test', 'test');
    j.done = [{ act: 'x'.repeat(200), result: 'ok', ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.done[0].act.length <= 80, 'act must be capped at 80 chars');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal truncates overlong result field to 120 chars', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('trunc test', 'test');
    j.done = [{ act: 'a task', result: 'y'.repeat(200), ts: new Date().toISOString() }];
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.done[0].result.length <= 120, 'result must be capped at 120 chars');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal preserves absent ctx as absent (not coerced to empty string)', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('ctx test', 'test');
    j.done = [{ act: 'task without ctx', result: 'ok', ts: new Date().toISOString() }]; // no ctx field
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(!('ctx' in loaded.done[0]), 'absent ctx must remain absent after round-trip');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal normalizes old completed/task fields to done/act on write', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const oldJournal = {
      mission: 'old schema', mission_opened: new Date().toISOString(),
      mission_closed: null, project: 'p', summary: null,
      state: 'active', state_reason: null, in_progress: null,
      completed: [{ task: 'legacy task', result: 'ok', ts: new Date().toISOString() }],
      upcoming: ['next step'],
    };
    writeJournal(journalPath, oldJournal);
    const loaded = readJournal(journalPath);
    assert.ok(Array.isArray(loaded.done), 'done must be written');
    assert.strictEqual(loaded.done[0].act, 'legacy task', 'task field must be migrated to act');
    assert.ok(Array.isArray(loaded.plan), 'plan must be written');
    assert.ok(!('completed' in loaded), 'old completed field must be gone');
    assert.ok(!('upcoming' in loaded), 'old upcoming field must be gone');
    assert.ok(!('state' in loaded), 'state field must be dropped');
    assert.ok(!('in_progress' in loaded), 'in_progress field must be dropped');
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
    fs.writeFileSync(journalPath, JSON.stringify({ done: [], plan: [] })); // no mission
    assert.strictEqual(readJournal(journalPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Newline sanitization (S3)
// ---------------------------------------------------------------------------

console.log('\nnewline sanitization');

test('writeJournal: summary with embedded newline is stored without newline', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('sanitize test', 'test');
    j.summary = 'line one\nline two';
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.summary && !loaded.summary.includes('\n'), 'summary must not contain newline after write');
    assert.ok(loaded.summary.includes('line one') && loaded.summary.includes('line two'), 'both parts must survive');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal: wip with embedded newline is stored without newline', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('sanitize wip test', 'test');
    j.wip = 'step one\nstep two';
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.ok(loaded.wip && !loaded.wip.includes('\n'), 'wip must not contain newline after write');
    assert.ok(loaded.wip.includes('step one') && loaded.wip.includes('step two'), 'both parts must survive');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal: summary with only newlines is stored as null', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('sanitize null test', 'test');
    j.summary = '\n\n';
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.strictEqual(loaded.summary, null, 'whitespace-only summary must be null after write');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal: normal text fields pass through unchanged', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'test.json');
    const j = newJournal('normal text test', 'test');
    j.wip = 'deploy auth service — build passed, uploading assets';
    j.summary = 'fixed auth, deployed to staging';
    writeJournal(journalPath, j);
    const loaded = readJournal(journalPath);
    assert.strictEqual(loaded.wip, 'deploy auth service — build passed, uploading assets');
    assert.strictEqual(loaded.summary, 'fixed auth, deployed to staging');
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
