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
// memento-activate.js — ctx_bridge injection
// ---------------------------------------------------------------------------

console.log('\nmemento-activate.js (ctx_bridge)');

function writeCtxBridgeFile(dir, overrides = {}) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const bridge = Object.assign({
    files: ['/foo.js'],
    next:  'run tests',
    err:   null,
    pct:   74,
    at:    '2026-05-23T00:00:00Z',
  }, overrides);
  const p = path.join(mementoDir, 'ctx_bridge.json');
  fs.writeFileSync(p, JSON.stringify(bridge, null, 2));
  return p;
}

// v0.5.1: bridge injection/deletion moved to tracker (drop detection).
// activate no longer injects [CTX BRIDGE] or deletes bridge file.

test('compact + bridge present → [CTX BRIDGE] NOT injected by activate (tracker responsibility)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'activate must not inject [CTX BRIDGE] in v0.5.1');
});

test('compact + bridge present → bridge NOT deleted by activate (tracker responsibility)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(fs.existsSync(bridgePath), 'activate must NOT delete bridge in v0.5.1');
});

test('recovery + bridge absent → output does NOT contain [CTX BRIDGE]', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'must not show [CTX BRIDGE] when no bridge');
});

test('startup + bridge present → [CTX BRIDGE] NOT injected, file NOT deleted', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'startup must not inject bridge');
  assert.ok(fs.existsSync(bridgePath), 'bridge must persist on startup');
});

test('startup does not consume bridge (bridge persists for tracker drop detection)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(fs.existsSync(bridgePath), 'bridge must persist after startup — tracker consumes it on drop');
});

// ---------------------------------------------------------------------------
// memento-tracker.js — ctx_bridge directive
// ---------------------------------------------------------------------------

console.log('\nmemento-tracker.js (ctx_bridge)');

const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'sample-session.jsonl');

function writeFixtureJsonl(dir, content) {
  const projDir = path.join(dir, 'projects', 'abc123');
  fs.mkdirSync(projDir, { recursive: true });
  const p = path.join(projDir, 'session.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

test('[BRIDGE] fires when JSONL at 78% used', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeFixtureJsonl(dir, require('fs').readFileSync(FIXTURE_JSONL, 'utf8'));
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[BRIDGE]'), 'must include [BRIDGE] directive at 78%');
});

test('[BRIDGE] includes the bridge file path', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeFixtureJsonl(dir, require('fs').readFileSync(FIXTURE_JSONL, 'utf8'));
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('ctx_bridge.json'), 'must include ctx_bridge.json path in directive');
});

test('[BRIDGE] does not fire when JSONL at 60% used', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  // 60% = 120000 tokens: input=1, cache_read=119899, cache_write=100 (not a spike) → total 120000
  const lowUsage = '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":119899,"cache_creation_input_tokens":100,"output_tokens":200}}}';
  writeFixtureJsonl(dir, lowUsage);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(!ctx.includes('[BRIDGE]'), 'must not fire [BRIDGE] at 60% without spike');
});

test('spike guard fires: 65% used + cacheWrite=5000 + no bridge file', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  // 65% = 130000 tokens: input=1, cache_read=124999, cache_write=5000 → total 130000
  const spikeUsage = '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":124999,"cache_creation_input_tokens":5000,"output_tokens":200}}}';
  writeFixtureJsonl(dir, spikeUsage);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[BRIDGE]'), 'spike guard must fire [BRIDGE] at 65% + spike');
});

test('spike guard skips if bridge file already exists', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  // 65% + spike, but bridge already exists
  const spikeUsage = '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":124999,"cache_creation_input_tokens":5000,"output_tokens":200}}}';
  writeFixtureJsonl(dir, spikeUsage);
  // Pre-create bridge file
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge.json'), '{"files":[],"next":"test","err":null,"pct":65,"at":"2026-05-23T00:00:00Z"}');
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  // At 65% it won't fire the primary trigger; spike guard skips because bridge exists
  assert.ok(!ctx.includes('[BRIDGE]'), 'spike guard must skip if bridge already exists');
});

// ---------------------------------------------------------------------------
// memento-tracker.js — drop detection / [CTX BRIDGE] injection
// ---------------------------------------------------------------------------

console.log('\nmemento-tracker.js (drop detection)');

// Write last_ctx sidecar (persisted ctx% from previous turn)
function writeLastCtxFile(dir, pct) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'testuser.last_ctx'), String(pct));
}

function readLastCtxFile(dir) {
  const p = path.join(dir, '.memento', 'testuser.last_ctx');
  try { return parseFloat(fs.readFileSync(p, 'utf8').trim()); } catch (e) { return null; }
}

// Write a JSONL at approximately the given ctx% (200k window)
function writeJsonlWithPct(dir, pct) {
  const totalTokens = Math.round(pct / 100 * 200000);
  const cacheRead   = Math.max(0, totalTokens - 1);
  const usage = `{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":${cacheRead},"cache_creation_input_tokens":0,"output_tokens":200}}}`;
  return writeFixtureJsonl(dir, usage);
}

test('[CTX BRIDGE] injected by tracker when ctx dropped ≥20pp and bridge exists', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);   // was 78%
  writeJsonlWithPct(dir, 21);  // now 21% — drop = 57pp
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[CTX BRIDGE]'), 'must inject [CTX BRIDGE] on 57pp drop');
  assert.ok(ctx.includes('/foo.js'), 'must show files from bridge');
  assert.ok(ctx.includes('run tests'), 'must show next from bridge');
});

test('bridge deleted by tracker after [CTX BRIDGE] injection', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);
  writeJsonlWithPct(dir, 21);
  const bridgePath = writeCtxBridgeFile(dir);
  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!fs.existsSync(bridgePath), 'bridge must be deleted after tracker consumes it');
});

test('[CTX BRIDGE] NOT injected when ctx only grew (no drop)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 30);   // was 30%
  writeJsonlWithPct(dir, 45);  // now 45% — grew, no drop
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when ctx grew');
});

test('[CTX BRIDGE] NOT injected on first run (no last_ctx file)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithPct(dir, 21);  // fresh session — no prior last_ctx
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when no last_ctx (first run)');
});

test('[CTX BRIDGE] NOT injected when drop detected but bridge absent', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);
  writeJsonlWithPct(dir, 21);
  // No bridge file
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 when bridge absent');
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when bridge absent');
});

test('last_ctx written every turn with current pct', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithPct(dir, 45);
  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const saved = readLastCtxFile(dir);
  assert.ok(saved !== null, 'last_ctx must be written after each turn');
  assert.ok(Math.abs(saved - 45) < 1, `saved pct (${saved}) must be ~45`);
});

test('drop below threshold (19pp) does not trigger [CTX BRIDGE]', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 40);   // was 40%
  writeJsonlWithPct(dir, 21);  // now 21% — drop = 19pp (below 20pp threshold)
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not fire at 19pp drop (below threshold)');
});

test('[CTX BRIDGE] shows pct from bridge data', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);
  writeJsonlWithPct(dir, 21);
  writeCtxBridgeFile(dir, { pct: 76 });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('76%'), 'must show pct from bridge');
});

test('[CTX BRIDGE] with no pct field → renders ?% not undefined%', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);
  writeJsonlWithPct(dir, 21);
  writeCtxBridgeFile(dir, { pct: undefined });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('?%'), 'missing pct must render as ?%');
  assert.ok(!ctx.includes('undefined%'), 'must not render undefined%');
});

test('[CTX BRIDGE] appears before [MEMENTO] in output (recovery context first)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 78);
  writeJsonlWithPct(dir, 21);
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  const bridgePos = ctx.indexOf('[CTX BRIDGE]');
  const mementoPos = ctx.indexOf('[MEMENTO]');
  assert.ok(bridgePos < mementoPos, '[CTX BRIDGE] must appear before [MEMENTO] in prompt');
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

test('precompact always emits [BRIDGE] directive (unconditional, even with no prior bridge)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  // No bridge file pre-created
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[BRIDGE]'), 'must emit [BRIDGE] directive unconditionally');
  assert.ok(r.stdout.includes('ctx_bridge.json'), 'must include bridge file path in directive');
});

test('precompact [BRIDGE] + MANDATORY WRITE in same output', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must still emit MANDATORY WRITE');
  assert.ok(r.stdout.includes('[BRIDGE]'), 'must emit [BRIDGE] directive');
  assert.ok(r.stdout.includes('LAST WRITE OPPORTUNITY'), 'must still say LAST WRITE OPPORTUNITY');
});

test('precompact emits [BRIDGE] when bridge file already exists (overwrite)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge.json'), '{"files":["/a.js"],"next":"test","err":null,"pct":78,"at":"2026-05-23T00:00:00Z"}');
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[BRIDGE]'), 'must emit [BRIDGE] even when bridge already exists (fresher overwrite)');
});

test('precompact + bridge absent → still emits [BRIDGE] directive (unconditional)', () => {
  const dir = tmpDir();
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[BRIDGE]'), 'must emit [BRIDGE] even when no prior bridge file');
});

test('precompact: neither branch uses hedging language ("may have been" must not appear)', () => {
  const dir1 = tmpDir();
  const dir2 = tmpDir();

  // With bridge
  const mementoDir = path.join(dir1, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge.json'), '{"files":[],"next":"test","err":null,"pct":74,"at":"2026-05-23T00:00:00Z"}');
  const r1 = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir1 });
  assert.ok(!r1.stdout.includes('may have been'), 'with-bridge output must not hedge with "may have been"');

  // Without bridge
  const r2 = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir2 });
  assert.ok(!r2.stdout.includes('may have been'), 'no-bridge output must not hedge with "may have been"');
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
