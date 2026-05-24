#!/usr/bin/env node
// Integration tests for memento hook scripts (v0.7.0)
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
      MEMENTO_PROJECT_HASH: 'testhash',
    }, extraEnv),
    timeout: 5000,
  });
}

// Write a v0.4.0 journal to dir/.memento/testuser-testhash.json
function writeV4Journal(dir, overrides = {}) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const journal = Object.assign({
    why:         'fixing auth for mobile',
    when:        '2026-05-21T14:00:00Z',
    why_history: [{ w: 'setup project', t: '2026-05-21T12:00:00Z' }],
  }, overrides);
  const journalPath = path.join(mementoDir, 'testuser-testhash.json');
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
  const journalPath = path.join(mementoDir, 'testuser-testhash.json');
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return journalPath;
}

// Write the turn counter file (v0.7.0: fixed per-instance path, no hash)
function writeTurnSidecar(dir, value) {
  const sidecarPath = path.join(dir, '.memento', 'testuser.turn');
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, String(value));
}

// Read the turn counter file (v0.7.0: fixed per-instance path, no hash)
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

// Create a fake `claude` binary that outputs a fixed string and exits with given code.
// Returns the path to the fake binary (pass as MEMENTO_CLAUDE_BIN env var).
function writeFakeClaude(dir, output, { exitCode = 0 } = {}) {
  const fakeBinDir = path.join(dir, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeClaude = path.join(fakeBinDir, 'fake-claude.js');
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  return fakeClaude;
}

// Write a minimal JSONL session file so findLatestJsonl() returns a path.
function writeJsonlForPrecompact(dir) {
  const projectDir = path.join(dir, 'projects', 'fakehash');
  fs.mkdirSync(projectDir, { recursive: true });
  const entry = JSON.stringify({ type: 'assistant', message: { usage: {
    input_tokens: 10000,
    cache_read_input_tokens: 100000,
    cache_creation_input_tokens: 50000,
    output_tokens: 500,
  }}});
  const jsonlPath = path.join(projectDir, 'session.jsonl');
  fs.writeFileSync(jsonlPath, entry + '\n');
  return jsonlPath;
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
  assert.ok(r.stdout.includes('memento-write-why.js'), 'must include write command');
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
  const p = path.join(mementoDir, 'ctx_bridge-testhash.json');
  fs.writeFileSync(p, JSON.stringify(bridge, null, 2));
  return p;
}

// v0.5.6: activate.js consumes bridge regardless of source — file existence is the signal.
// All sources (compact, resume, startup) now inject and delete any present bridge.

test('compact + bridge present → [CTX BRIDGE] injected by activate (v0.5.6: source-agnostic)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[CTX BRIDGE]'), 'activate must inject [CTX BRIDGE] for compact source (v0.5.6)');
  assert.ok(r.stdout.includes('run tests'), 'must show next from bridge');
});

test('compact + bridge present → bridge deleted by activate (v0.5.6)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!fs.existsSync(bridgePath), 'activate must delete bridge for compact source (v0.5.6)');
});

test('resume + bridge present → [CTX BRIDGE] injected and bridge deleted (v0.5.6)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"resume"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(r.stdout.includes('[CTX BRIDGE]'), 'activate must inject [CTX BRIDGE] for resume source (v0.5.6)');
  assert.ok(!fs.existsSync(bridgePath), 'bridge must be deleted on resume');
});

test('recovery + bridge absent → output does NOT contain [CTX BRIDGE]', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const r = runHook('memento-activate.js', '{"source":"compact"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'must not show [CTX BRIDGE] when no bridge');
});

test('startup + bridge present → [CTX BRIDGE] injected and bridge deleted', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const bridgePath = writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(r.stdout.includes('[CTX BRIDGE]'), 'startup must inject [CTX BRIDGE] from SessionEnd bridge');
  assert.ok(r.stdout.includes('run tests'), 'must show next from bridge');
  assert.ok(!fs.existsSync(bridgePath), 'bridge must be deleted after startup injection');
});

test('startup + bridge absent → [CTX BRIDGE] NOT injected', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'startup must not inject [CTX BRIDGE] when no bridge');
});

test('startup bridge: [CTX BRIDGE] appears before MANDATORY WRITE', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  writeCtxBridgeFile(dir);
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  const bridgePos   = r.stdout.indexOf('[CTX BRIDGE]');
  const mandatoryPos = r.stdout.indexOf('MANDATORY WRITE');
  assert.ok(bridgePos < mandatoryPos, '[CTX BRIDGE] must appear before MANDATORY WRITE');
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
  assert.ok(ctx.includes('ctx_bridge-testhash.json'), 'must include ctx_bridge-testhash.json path in directive');
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
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'), '{"files":[],"next":"test","err":null,"pct":65,"at":"2026-05-23T00:00:00Z"}');
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

// Write last_ctx file (v0.7.0: fixed per-instance path, no hash)
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

test('[CTX BRIDGE] injected via fallback: no last_ctx + ctx below trigger threshold', () => {
  // v0.5.2: if last_ctx missing but ctx < BRIDGE_TRIGGER_PCT, compaction is inferred
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithPct(dir, 21);  // post-compaction ctx — well below 74% trigger
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('[CTX BRIDGE]'), 'must inject via fallback when no last_ctx and ctx < trigger');
});

test('[CTX BRIDGE] NOT injected: no last_ctx + ctx above trigger threshold (no compaction)', () => {
  // v0.5.2: fallback only fires when ctx < BRIDGE_TRIGGER_PCT
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithPct(dir, 80);  // high ctx — above trigger, no compaction
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when ctx above trigger (no compaction inferred)');
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
  assert.ok(r.stdout.includes('memento-write-why.js'), 'must include write command');
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

test('precompact emits only MANDATORY WRITE (no [BRIDGE] directive — hook writes bridge directly)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const fakeClaude = writeFakeClaude(dir, '{"files":[],"next":"test","err":null}');
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });
  assert.ok(r.stdout.includes('MANDATORY WRITE'), 'must emit MANDATORY WRITE');
  assert.ok(r.stdout.includes('LAST WRITE OPPORTUNITY'), 'must say LAST WRITE OPPORTUNITY');
  assert.ok(!r.stdout.includes('[BRIDGE]'), 'must NOT emit [BRIDGE] directive — hook writes bridge itself');
});

test('precompact: writes bridge via claude -p when no existing bridge', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'debugging auth' });
  writeJsonlForPrecompact(dir);
  const fakeClaude = writeFakeClaude(dir, '{"files":["/home/foo.js"],"next":"run tests","err":null}');

  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });
  assert.strictEqual(r.status, 0);

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(fs.existsSync(bridgePath), 'bridge must be written by hook');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  assert.deepStrictEqual(bridge.files, ['/home/foo.js'], 'files must come from claude -p output');
  assert.strictEqual(bridge.next, 'run tests', 'next must come from claude -p output');
  assert.strictEqual(bridge.err, null, 'err must be null');
});

test('precompact: does NOT overwrite existing bridge (tracker bridge is richer)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  writeJsonlForPrecompact(dir);
  const fakeClaude = writeFakeClaude(dir, '{"files":["/new.js"],"next":"new step","err":null}');

  // Pre-existing bridge written by tracker at 78%
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const existing = '{"files":["/old.js"],"next":"old step","err":null,"pct":78,"at":"2026-05-23T00:00:00Z"}';
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'), existing);

  runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });

  const bridge = JSON.parse(fs.readFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'), 'utf8'));
  assert.strictEqual(bridge.next, 'old step', 'must preserve tracker-written bridge');
  assert.deepStrictEqual(bridge.files, ['/old.js'], 'must preserve tracker-written files');
});

test('precompact: falls back to journal.why if claude -p fails', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'implementing feature X' });
  writeJsonlForPrecompact(dir);
  const fakeClaude = writeFakeClaude(dir, 'not json', { exitCode: 1 });

  runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(fs.existsSync(bridgePath), 'fallback bridge must be written');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  assert.strictEqual(bridge.next, 'implementing feature X', 'fallback next must equal journal.why');
  assert.deepStrictEqual(bridge.files, [], 'fallback files must be empty');
});

test('precompact: no bridge written if no journal and claude -p unavailable', () => {
  const dir = tmpDir();
  // No journal; claude exits non-zero
  const fakeClaude = writeFakeClaude(dir, '', { exitCode: 1 });

  runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(!fs.existsSync(bridgePath), 'no bridge must be written without journal fallback');
});

test('precompact: uses transcript_path from stdin when valid', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  // Write JSONL at a custom path (not in projects/ dir)
  const jsonlPath = path.join(dir, 'custom.jsonl');
  fs.writeFileSync(jsonlPath, '{"type":"assistant","message":{"usage":{"input_tokens":1}}}\n');
  const fakeClaude = writeFakeClaude(dir, '{"files":["/src/main.js"],"next":"fix the bug","err":"TypeError"}');

  const stdin = JSON.stringify({ transcript_path: jsonlPath });
  runHook('memento-precompact.js', stdin, { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(fs.existsSync(bridgePath), 'bridge must be written using stdin transcript_path');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  assert.strictEqual(bridge.err, 'TypeError', 'err must come from claude -p output');
  assert.strictEqual(bridge.next, 'fix the bug');
});

test('precompact: output does not contain hedging language ("may have been" must not appear)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  const fakeClaude = writeFakeClaude(dir, '{"files":[],"next":"test","err":null}');
  const r = runHook('memento-precompact.js', '{}', { CLAUDE_CONFIG_DIR: dir, MEMENTO_CLAUDE_BIN: fakeClaude });
  assert.ok(!r.stdout.includes('may have been'), 'output must not hedge with "may have been"');
});

// ---------------------------------------------------------------------------
// memento-sessionend.js (SessionEnd)
// ---------------------------------------------------------------------------

console.log('\nmemento-sessionend.js');

test('sessionend: writes minimal bridge directly from journal.why (v0.5.5: no claude -p)', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'debugging auth' });
  writeJsonlForPrecompact(dir);

  const r = runHook('memento-sessionend.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0);

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(fs.existsSync(bridgePath), 'bridge must be written by sessionend hook');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  assert.deepStrictEqual(bridge.files, [], 'files must always be empty (minimal bridge)');
  assert.strictEqual(bridge.next, 'debugging auth', 'next must equal journal.why');
  assert.strictEqual(bridge.err, null, 'err must be null');
});

test('sessionend: does NOT overwrite existing bridge', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'new step from journal' });

  // Pre-existing bridge (e.g. written by tracker at 78%)
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'),
    '{"files":["/old.js"],"next":"old step","err":null,"pct":78,"at":"2026-05-23T00:00:00Z"}');

  runHook('memento-sessionend.js', '{}', { CLAUDE_CONFIG_DIR: dir });

  const bridge = JSON.parse(fs.readFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'), 'utf8'));
  assert.strictEqual(bridge.next, 'old step', 'must preserve existing bridge');
});

test('sessionend: no bridge written if no journal', () => {
  const dir = tmpDir();
  // No journal at all
  runHook('memento-sessionend.js', '{}', { CLAUDE_CONFIG_DIR: dir });

  const bridgePath = path.join(dir, '.memento', 'ctx_bridge-testhash.json');
  assert.ok(!fs.existsSync(bridgePath), 'no bridge must be written without journal');
});

test('sessionend: silent fail on error (exits 0)', () => {
  const dir = tmpDir();
  const r = runHook('memento-sessionend.js', 'bad json', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 on invalid stdin');
});

test('sessionend: no stdout output (session is ending, nothing to inject)', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'finalizing deploy' });
  const r = runHook('memento-sessionend.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.stdout, '', 'sessionend must produce no stdout output');
});

// ---------------------------------------------------------------------------
// memento-write-why.js (journal write helper)
// ---------------------------------------------------------------------------

console.log('\nmemento-write-why.js');

function runWriteScript(why, extraEnv = {}) {
  const args = why !== undefined ? [path.join(HOOKS_DIR, 'memento-write-why.js'), why] : [path.join(HOOKS_DIR, 'memento-write-why.js')];
  return spawnSync('node', args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      MEMENTO_DEBUG: '',
      MEMENTO_INSTANCE_TAG: 'testuser',
      MEMENTO_PROJECT_HASH: 'testhash',
    }, extraEnv),
    timeout: 5000,
  });
}

function readWrittenJournal(dir) {
  const journalPath = path.join(dir, '.memento', 'testuser-testhash.json');
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (e) { return null; }
}

test('write-why: creates journal from scratch (no existing)', () => {
  const dir = tmpDir();
  const r = runWriteScript('fixing auth for mobile', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, `must exit 0; stderr: ${r.stderr}`);
  const j = readWrittenJournal(dir);
  assert.ok(j !== null, 'journal must be written');
  assert.strictEqual(j.why, 'fixing auth for mobile');
  assert.deepStrictEqual(j.why_history, [], 'history must be empty on first write');
});

test('write-why: appends to why_history when why changes', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'setup project', when: '2026-05-21T12:00:00Z', why_history: [] });
  runWriteScript('fixing auth for mobile', { CLAUDE_CONFIG_DIR: dir });
  const j = readWrittenJournal(dir);
  assert.strictEqual(j.why, 'fixing auth for mobile');
  assert.strictEqual(j.why_history.length, 1, 'history must have one entry');
  assert.strictEqual(j.why_history[0].w, 'setup project');
});

test('write-why: does not append to why_history when why is same', () => {
  const dir = tmpDir();
  writeV4Journal(dir, { why: 'fixing auth', when: '2026-05-21T14:00:00Z', why_history: [{ w: 'setup', t: '2026-05-21T12:00:00Z' }] });
  runWriteScript('fixing auth', { CLAUDE_CONFIG_DIR: dir });
  const j = readWrittenJournal(dir);
  assert.strictEqual(j.why, 'fixing auth');
  assert.strictEqual(j.why_history.length, 1, 'history must be unchanged on same-value write');
});

test('write-why: truncates why to 200 chars', () => {
  const dir = tmpDir();
  const longWhy = 'x'.repeat(300);
  runWriteScript(longWhy, { CLAUDE_CONFIG_DIR: dir });
  const j = readWrittenJournal(dir);
  assert.strictEqual(j.why.length, 200, 'why must be truncated to 200 chars');
});

test('write-why: exits 0 and no-ops on empty argument', () => {
  const dir = tmpDir();
  const r = runWriteScript('', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 on empty why');
  assert.strictEqual(readWrittenJournal(dir), null, 'must not write journal on empty why');
});

test('write-why: exits 0 and no-ops with no argument', () => {
  const dir = tmpDir();
  const r = runWriteScript(undefined, { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 with no argument');
  assert.strictEqual(readWrittenJournal(dir), null, 'must not write journal with no argument');
});

test('write-why: produces no stdout output', () => {
  const dir = tmpDir();
  const r = runWriteScript('fixing auth', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.stdout, '', 'must produce no stdout output');
});

test('write-why: written journal uses atomic writeJournal (0600 permissions)', () => {
  const dir = tmpDir();
  runWriteScript('fixing auth for mobile', { CLAUDE_CONFIG_DIR: dir });
  const journalPath = path.join(dir, '.memento', 'testuser-testhash.json');
  const st = fs.statSync(journalPath);
  // Check owner-read-write, no group/other permissions (0600)
  // eslint-disable-next-line no-bitwise
  assert.strictEqual(st.mode & 0o777, 0o600, 'journal must be written with 0600 permissions');
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
