#!/usr/bin/env node
// Integration tests for memento hook scripts (SessionStart + UserPromptSubmit)
// Runs hooks as subprocesses with isolated CLAUDE_CONFIG_DIR to avoid touching real journals.
'use strict';

const assert   = require('assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memento-hooktest-'));
}

// Run a hook script and return { status, stdout, stderr }
function runHook(script, input, extraEnv = {}) {
  return spawnSync('node', [path.join(HOOKS_DIR, script)], {
    input,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      MEMENTO_DEBUG: '',        // disable debug output in tests
      MEMENTO_INSTANCE_TAG: 'testuser',
    }, extraEnv),
    timeout: 5000,
  });
}

// Write a sample journal to dir/.memento/testuser.json
function writeTestJournal(dir, overrides = {}) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  // writeTestJournal intentionally uses OLD schema (completed/upcoming/task) to test backward-compat
  const journal = Object.assign({
    mission:        'test mission',
    mission_opened: new Date().toISOString(),
    mission_closed: null,
    project:        'testproj',
    summary:        null,
    state:          'active',
    state_reason:   null,
    in_progress:    null,
    completed:      [{ task: 'completed task', result: 'success', ts: new Date().toISOString() }],
    upcoming:       ['next step'],
  }, overrides);
  const journalPath = path.join(mementoDir, 'testuser.json');
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return journalPath;
}

// ---------------------------------------------------------------------------
// memento-activate.js (SessionStart)
// ---------------------------------------------------------------------------

console.log('\nmemento-activate.js');

test('no journal: emits path hint with [MEMENTO] No prior journal', () => {
  const dir = tmpDir();
  try {
    const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0, `exit code must be 0; stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('[MEMENTO] No prior journal'), 'must emit path hint');
    assert.ok(r.stdout.includes('testuser'), 'hint must include instance tag');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('startup + journal: brief mode (count line, no Done: lines)', () => {
  const dir = tmpDir();
  try {
    writeTestJournal(dir);
    const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('[MEMENTO]'), 'must include [MEMENTO] header');
    assert.ok(r.stdout.includes('task(s) done'), 'must include done count');
    assert.ok(!r.stdout.includes('Done:'), 'brief mode must NOT include Done: lines');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('compact + journal: full mode (Done: and Next: present)', () => {
  const dir = tmpDir();
  try {
    writeTestJournal(dir);
    const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('Done: completed task'), 'must include Done: line (backward-compat from task field)');
    assert.ok(r.stdout.includes('Plan: next step'), 'must include Plan: line (backward-compat from upcoming field)');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('resume + journal: full mode (same as compact)', () => {
  const dir = tmpDir();
  try {
    writeTestJournal(dir);
    const r = runHook('memento-activate.js', '{"source":"resume"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('Done:'), 'resume mode must include Done: lines');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('corrupted journal: exits cleanly with no output (or path hint)', () => {
  const dir = tmpDir();
  try {
    const mementoDir = path.join(dir, '.memento');
    fs.mkdirSync(mementoDir, { recursive: true });
    fs.writeFileSync(path.join(mementoDir, 'testuser.json'), 'not json {{{');
    const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0, 'corrupt journal must not crash hook');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('invalid stdin: exits cleanly (silent fail)', () => {
  const dir = tmpDir();
  try {
    const r = runHook('memento-activate.js', 'not json at all', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0, 'invalid stdin must not crash hook');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// memento-tracker.js (UserPromptSubmit)
// ---------------------------------------------------------------------------

console.log('\nmemento-tracker.js');

test('/clear: exits with 0, no stdout', () => {
  const dir = tmpDir();
  try {
    const r = runHook('memento-tracker.js', '{"prompt":"/clear"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'no stdout on /clear with no journal');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('/clear + journal: sets mission_closed + clears upcoming', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"/clear"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.ok(updated.mission_closed, 'mission_closed must be set after /clear');
    assert.strictEqual(updated.plan.length, 0, 'plan must be cleared after /clear');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('active mission: emits hookSpecificOutput reminder', () => {
  const dir = tmpDir();
  try {
    writeTestJournal(dir);
    const r = runHook('memento-tracker.js', '{"prompt":"run the analysis"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.length > 0, 'must emit reminder for active mission');
    const json = JSON.parse(r.stdout);
    assert.ok(json.hookSpecificOutput, 'output must be hookSpecificOutput format');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('[MEMENTO:'), 'reminder must include [MEMENTO: prefix');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('active mission with empty done[]: reminder includes unprotected warning', () => {
  const dir = tmpDir();
  try {
    writeTestJournal(dir, { done: [], completed: [], wip: null, in_progress: null });
    const r = runHook('memento-tracker.js', '{"prompt":"start the analysis"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('no entries yet'), 'empty-done reminder must include "no entries yet"');
    assert.ok(ctx.includes('unprotected'), 'empty-done reminder must include "unprotected"');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('closed mission: emits prior-mission-closed reminder', () => {
  const dir = tmpDir();
  try {
    const closedAt = new Date().toISOString();
    writeTestJournal(dir, { mission_closed: closedAt });
    const r = runHook('memento-tracker.js', '{"prompt":"some prompt"}', { CLAUDE_CONFIG_DIR: dir });
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes('Mission closed'),
      'closed mission must emit mission-closed reminder'
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// False positive checks — coding phrases that must NOT close the mission

test('false positive: "starting over the loop" must NOT close mission', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"starting over the loop in the function"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(updated.mission_closed, null, '"starting over the loop" must not close mission');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('false positive: "fresh start on the function" must NOT close mission', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"let me take a fresh start on the function"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(updated.mission_closed, null, '"fresh start on function" must not close mission');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('false positive: "new mission params" must NOT close mission', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"what are the new mission params for this function?"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(updated.mission_closed, null, '"new mission params" must not close mission');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('true positive: "switching to a different project" closes mission', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"I am switching to a different project now"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.ok(updated.mission_closed, '"switching to a different project" must close mission');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('true positive: "starting over from scratch" closes mission', () => {
  const dir = tmpDir();
  try {
    const journalPath = writeTestJournal(dir);
    runHook('memento-tracker.js', '{"prompt":"I want to start over from scratch on this"}', { CLAUDE_CONFIG_DIR: dir });
    const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.ok(updated.mission_closed, '"starting over from scratch" must close mission');
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
