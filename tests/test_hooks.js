#!/usr/bin/env node
// Integration tests for memento hook scripts (v0.4.0)
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
      MEMENTO_DEBUG: '',
      MEMENTO_INSTANCE_TAG: 'testuser',
    }, extraEnv),
    timeout: 5000,
  });
}

// Write a v0.4.0 journal to dir/.memento/testuser.json
function writeV4Journal(dir, overrides = {}) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const journal = Object.assign({
    why:         'fixing auth for mobile',
    when:        '2026-05-21T14:00:00Z',
    why_history: [{ w: 'setup project', t: '2026-05-21T12:00:00Z' }],
  }, overrides);
  const journalPath = path.join(mementoDir, 'testuser.json');
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return journalPath;
}

// Write a pre-v0.4.0 journal (old schema, no why field)
function writeOldSchemaJournal(dir) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const journal = {
    mission:        'old mission',
    mission_opened: new Date().toISOString(),
    mission_closed: null,
    project:        'default',
    done:           [],
    plan:           [],
  };
  const journalPath = path.join(mementoDir, 'testuser.json');
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return journalPath;
}

// Write the turn sidecar file
function writeTurnSidecar(dir, value) {
  const sidecarPath = path.join(dir, '.memento', 'testuser.turn');
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, String(value));
}

// Read the turn sidecar file
function readTurnSidecar(dir) {
  const sidecarPath = path.join(dir, '.memento', 'testuser.turn');
  try { return parseInt(fs.readFileSync(sidecarPath, 'utf8').trim(), 10); } catch (e) { return null; }
}

// Parse hook output as additionalContext (for UserPromptSubmit hooks)
function parseAdditionalContext(stdout) {
  try {
    const obj = JSON.parse(stdout);
    return obj && obj.hookSpecificOutput && obj.hookSpecificOutput.additionalContext
      ? obj.hookSpecificOutput.additionalContext
      : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// memento-activate.js (SessionStart)
// ---------------------------------------------------------------------------

console.log('\nmemento-activate.js');

test('startup + no journal: emits Turn 1 / No Journal prompt', () => {
  const dir = tmpDir();
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, `exit code must be 0; stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('[MEMENTO] MANDATORY WRITE | Turn 1'), 'must include MANDATORY WRITE Turn 1 header');
  assert.ok(r.stdout.includes('No prior journal'), 'must include No prior journal');
  assert.ok(r.stdout.includes('[GUESS]'), 'must mention [GUESS] option');
});

test('startup + confirmed why journal: emits Turn 1 / Confirmed Why prompt', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'fixing auth for mobile', why_history: [] });
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[MEMENTO] MANDATORY WRITE | Turn 1'), 'must have MANDATORY WRITE Turn 1');
  assert.ok(r.stdout.includes('"fixing auth for mobile"'), 'must show previous why');
  assert.ok(r.stdout.includes('Same is fine'), 'must say Same is fine for confirmed why');
});

test('startup + [GUESS] why journal: emits Turn 1 / [GUESS] Why prompt', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: '[GUESS] probably fixing auth', why_history: [] });
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[MEMENTO] MANDATORY WRITE | Turn 1'), 'must have MANDATORY WRITE Turn 1');
  assert.ok(r.stdout.includes('[GUESS] probably fixing auth'), 'must show [GUESS] why');
  assert.ok(r.stdout.includes('Drop [GUESS] only if'), 'must include [GUESS] drop instruction');
});

test('startup: resets turn sidecar to 0', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 99); // pre-set to something non-zero
  runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  const turn = readTurnSidecar(dir);
  assert.strictEqual(turn, 0, 'startup must reset sidecar to 0');
});

test('compact + confirmed why journal: emits Recovery prompt', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'fixing auth for mobile', when: '2026-05-21T14:30:00Z' });
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[MEMENTO] Recovering'), 'must show Recovering header');
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must say MANDATORY WRITE');
  assert.ok(r.stdout.includes('"fixing auth for mobile"'), 'must show why');
  assert.ok(r.stdout.includes('[...existing entries...]'), 'must show existing entries placeholder');
});

test('resume + confirmed why journal: same as compact (Recovery prompt)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const r = runHook('memento-activate.js', '{"source":"resume"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[MEMENTO] Recovering'), 'resume must also produce Recovering header');
});

test('compact + no journal: emits Recovery / no-journal prompt', () => {
  const dir = tmpDir();
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[MEMENTO] Recovering'), 'must show Recovering even with no journal');
  assert.ok(r.stdout.includes('No prior journal'), 'must say No prior journal');
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must say MANDATORY WRITE');
});

test('compact: resets turn sidecar to 1 (not 0)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  const turn = readTurnSidecar(dir);
  assert.strictEqual(turn, 1, 'compact must reset sidecar to 1 to skip T1 full prompt');
});

test('recovery + [GUESS] why: shows [GUESS] framing in Arc line', () => {
  const dir = tmpDir();
  writeV4Journal(dir, {
    why: '[GUESS] probably fixing auth',
    when: '2026-05-21T14:00:00Z',
    why_history: [{ w: 'setup project', t: '2026-05-21T12:00:00Z' }],
  });
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[GUESS] probably fixing auth'), 'must show [GUESS] why');
  assert.ok(r.stdout.includes('Arc:'), 'must show Arc line when history present');
});

test('recovery: Arc line shown when why_history has entries', () => {
  const dir = tmpDir();
  writeV4Journal(dir, {
    why: 'fixing auth',
    when: '2026-05-21T14:00:00Z',
    why_history: [
      { w: 'setup project', t: '2026-05-21T12:00:00Z' },
      { w: 'reviewing codebase', t: '2026-05-21T13:00:00Z' },
    ],
  });
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(r.stdout.includes('Arc:'), 'Arc line must appear when why_history has entries');
});

test('recovery: no Arc line when why_history is empty', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'fixing auth', why_history: [] });
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('Arc:'), 'no Arc line when why_history is empty');
});

test('old-schema journal treated as no journal (Turn 1 / No Journal)', () => {
  const dir = tmpDir();
  writeOldSchemaJournal(dir);
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No prior journal'), 'old-schema journal must be treated as no journal');
});

test('invalid stdin: exits cleanly (silent fail)', () => {
  const dir = tmpDir();
  const r = runHook('memento-activate.js', 'not valid json', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 on invalid stdin');
});

// ---------------------------------------------------------------------------
// memento-tracker.js (UserPromptSubmit)
// ---------------------------------------------------------------------------

console.log('\nmemento-tracker.js');

test('sidecar=0 + no journal: emits Turn 1 / No Journal prompt', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null, 'must emit hookSpecificOutput.additionalContext');
  assert.ok(ctx.includes('[MEMENTO] MANDATORY WRITE | Turn 1'), 'must be Turn 1');
  assert.ok(ctx.includes('No prior journal'), 'must say No prior journal');
  assert.ok(ctx.includes('[GUESS]'), 'must mention [GUESS]');
});

test('sidecar=0 + confirmed why: emits Turn 1 / Confirmed Why prompt', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir, { why: 'fixing auth', why_history: [] });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Turn 1'), 'must be Turn 1');
  assert.ok(ctx.includes('"fixing auth"'), 'must show previous why');
  assert.ok(ctx.includes('Same is fine'), 'must say Same is fine');
});

test('sidecar=0 + [GUESS] why: emits Turn 1 / [GUESS] prompt', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir, { why: '[GUESS] probably setting up', why_history: [] });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[GUESS] probably setting up'), 'must show [GUESS] why');
  assert.ok(ctx.includes('Drop [GUESS]'), 'must include Drop [GUESS] instruction');
});

test('sidecar=1 + confirmed why: emits compressed Turn 2 prompt', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir, { why: 'fixing auth', why_history: [] });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Turn 2'), 'must say Turn 2');
  assert.ok(ctx.includes('"fixing auth"'), 'must show previous why');
  assert.ok(ctx.includes('Same ok'), 'compressed format must say Same ok');
  // Must NOT include the full schema template (compressed format)
  assert.ok(!ctx.includes('"why_history":[{"w"'), 'compressed format must not include full template');
});

test('sidecar=5 + [GUESS] why: emits compressed Turn 6 prompt', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 5);
  writeV4Journal(dir, { why: '[GUESS] probably reviewing', why_history: [] });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Turn 6'), 'must say Turn 6');
  assert.ok(ctx.includes('[GUESS] probably reviewing'), 'must show [GUESS] why');
  assert.ok(ctx.includes('Drop [GUESS]'), 'must say Drop [GUESS] when previous is [GUESS]');
});

test('sidecar=2 + no journal: emits no-journal-yet prompt for Turn 3', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 2);
  // No journal written
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Turn 3'), 'must say Turn 3');
  assert.ok(ctx.includes('No journal written yet'), 'must say No journal written yet');
  assert.ok(ctx.includes('[GUESS]'), 'must mention [GUESS]');
});

test('sidecar incremented after each call', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);

  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(readTurnSidecar(dir), 1, 'after first call, sidecar must be 1');

  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(readTurnSidecar(dir), 2, 'after second call, sidecar must be 2');
});

test('missing sidecar treated as turn 0 (graceful degradation)', () => {
  const dir = tmpDir();
  // No sidecar file — simulate first run without activate.js having run
  writeV4Journal(dir, { why: 'test', why_history: [] });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Turn 1'), 'missing sidecar must produce Turn 1');
});

test('old-schema journal treated as no journal (Turn N / no journal yet)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 3); // Turn 4
  writeOldSchemaJournal(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('No journal written yet'), 'old-schema journal treated as missing');
});

test('invalid stdin: exits cleanly', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  const r = runHook('memento-tracker.js', 'bad input', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 on invalid stdin');
});

// ---------------------------------------------------------------------------
// memento-precompact.js (PreCompact)
// ---------------------------------------------------------------------------

console.log('\nmemento-precompact.js');

test('precompact + confirmed why: emits LAST WRITE OPPORTUNITY with why', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'fixing auth for mobile', when: '2026-05-21T14:00:00Z' });
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('LAST WRITE OPPORTUNITY'), 'must say LAST WRITE OPPORTUNITY');
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must say MANDATORY WRITE');
  assert.ok(r.stdout.includes('"fixing auth for mobile"'), 'must show current why');
  assert.ok(r.stdout.includes('Append to why_history only if why changed'), 'must include history instruction');
});

test('precompact + [GUESS] why: emits LAST WRITE OPPORTUNITY with [GUESS] framing', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: '[GUESS] probably reviewing codebase', when: '2026-05-21T14:00:00Z' });
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[GUESS] probably reviewing codebase'), 'must show [GUESS] why');
  assert.ok(r.stdout.includes('LAST WRITE OPPORTUNITY'), 'must say LAST WRITE OPPORTUNITY');
});

test('precompact + no journal: emits LAST WRITE OPPORTUNITY no-journal prompt', () => {
  const dir = tmpDir();
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('LAST WRITE OPPORTUNITY'), 'must say LAST WRITE OPPORTUNITY even with no journal');
  assert.ok(r.stdout.includes('No prior journal'), 'must say No prior journal');
  assert.ok(r.stdout.includes('[GUESS]'), 'must mention [GUESS]');
});

test('precompact + old-schema journal: treated as no journal', () => {
  const dir = tmpDir();
  writeOldSchemaJournal(dir);
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No prior journal'), 'old-schema journal must produce no-journal prompt');
});

test('precompact: always fires (not conditional on wip/journal state)', () => {
  // Previously precompact was silent when wip was already set. Now always fires.
  const dir = tmpDir();
  // Journal is clean and complete
  writeV4Journal(dir, {
    why: 'deploy complete',
    why_history: [{ w: 'setup', t: '2026-05-21T12:00:00Z' }],
  });
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must always emit mandatory write, never silent');
});

test('precompact: silent fail on error (exits 0)', () => {
  const dir = tmpDir();
  // No .memento dir, no journal — still exits 0 cleanly
  const r = runHook('memento-precompact.js', 'bad json', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
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
