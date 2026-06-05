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

// Conversation / project hashing — used by the real-divergence tests to assert the
// precondition (writer and reader resolve DIFFERENT conversation hashes) without faking it.
const { getConversationHash, getProjectHash } = require(path.join(HOOKS_DIR, 'memento-config.js'));

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
    left:  40000,
    at:    new Date().toISOString(),  // recent by default — startup gating is TTL-based (v0.8.0)
  }, overrides);
  const p = path.join(mementoDir, 'ctx_bridge-testhash.json');
  fs.writeFileSync(p, JSON.stringify(bridge, null, 2));
  return p;
}

// v0.8.0: bridge consumption is gated by source. resume/compact consume any bridge
// unconditionally (same conversation). startup/clear only consume a RECENT bridge
// (within BRIDGE_MAX_AGE) so an unrelated older session's bridge never surfaces.

test('compact + bridge present → [CTX BRIDGE] injected by activate (recovery, unconditional)', () => {
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

test('startup + STALE bridge → NOT injected but deleted (v0.8.0 TTL gating)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  // Bridge older than BRIDGE_MAX_AGE (6h) — an unrelated prior session's leftover.
  const bridgePath = writeCtxBridgeFile(dir, { at: '2026-05-23T00:00:00Z' });
  const r = runHook('memento-activate.js', '{"source":"startup"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'), 'stale bridge must not surface on a fresh startup');
  assert.ok(!fs.existsSync(bridgePath), 'stale bridge must still be cleaned up (one-shot)');
});

test('resume + STALE bridge → still injected (recovery ignores TTL)', () => {
  const dir = tmpDir();
  writeV4Journal(dir);
  writeCtxBridgeFile(dir, { at: '2026-05-23T00:00:00Z' });
  const r = runHook('memento-activate.js', '{"source":"resume"}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(r.stdout.includes('[CTX BRIDGE]'), 'resume reattaches same conversation — age does not matter');
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
// memento-activate.js — cross-session bridge handoff (regression)
//
// The ctx_bridge is a CROSS-conversation handoff: the prior conversation writes it,
// the next, DIFFERENT conversation must read it. v0.7.0–v0.8.0 keyed it by
// conversationHash, so a fresh new conversation looked it up under a hash the prior
// conversation never wrote — the handoff was structurally impossible. The bridge is
// now PROJECT-scoped while the journal stays conversation-scoped.
//
// These tests deliberately do NOT set MEMENTO_PROJECT_HASH: that override collapses
// conversationHash and projectHash to one value, which is exactly why the rest of the
// suite never caught this bug. Here we let them differ (real-world condition).
// ---------------------------------------------------------------------------

console.log('\nmemento-activate.js (cross-session bridge handoff)');

const mementoConfig = require(path.join(HOOKS_DIR, 'memento-config.js'));

test('startup: fresh new-conversation activate picks up a project-scoped bridge from a prior conversation', () => {
  const dir = tmpDir();

  // projectHash is what getProjectHash() resolves to inside the hook subprocess
  // (same cwd as this runner → same value). The prior conversation's bridge lives here.
  const projectHash = mementoConfig.getProjectHash();

  // The NEW session's live transcript → a DIFFERENT conversation hash.
  const newTranscript = path.join(dir, 'new-conversation.jsonl');
  const conversationHash = mementoConfig.getConversationHash(newTranscript);
  assert.notStrictEqual(conversationHash, projectHash,
    'precondition: conversation hash must differ from project hash (else the bug is masked)');

  // Prior conversation left a recent, project-scoped bridge.
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const projectBridgePath = path.join(mementoDir, `ctx_bridge-${projectHash}.json`);
  fs.writeFileSync(projectBridgePath, JSON.stringify({
    files: ['/src/app.js'],
    next:  'finish the cross-session handoff fix',
    err:   null,
    left:  40000,
    at:    new Date().toISOString(),
  }, null, 2));

  const stdin = JSON.stringify({ source: 'startup', transcript_path: newTranscript });
  const r = runHook('memento-activate.js', stdin, {
    CLAUDE_CONFIG_DIR:    dir,
    MEMENTO_PROJECT_HASH: '',   // disable override so the two hashes genuinely differ
  });

  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[CTX BRIDGE]'),
    'fresh new-conversation startup must surface the prior conversation\'s project-scoped bridge');
  assert.ok(r.stdout.includes('finish the cross-session handoff fix'),
    'must show next from the project-scoped bridge');
  assert.ok(!fs.existsSync(projectBridgePath),
    'bridge must be deleted after pickup (one-shot)');
});

test('startup: a conversation-hash-keyed bridge is NOT consumed (regression guard for the old buggy key)', () => {
  const dir = tmpDir();
  const projectHash = mementoConfig.getProjectHash();
  const newTranscript = path.join(dir, 'another-conversation.jsonl');
  const conversationHash = mementoConfig.getConversationHash(newTranscript);
  assert.notStrictEqual(conversationHash, projectHash, 'precondition: hashes differ');

  // Write a bridge at the OLD (buggy) conversation-hash location.
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const convBridgePath = path.join(mementoDir, `ctx_bridge-${conversationHash}.json`);
  fs.writeFileSync(convBridgePath, JSON.stringify({
    files: [], next: 'should NOT be picked up', err: null,
    left: 40000, at: new Date().toISOString(),
  }, null, 2));

  const stdin = JSON.stringify({ source: 'startup', transcript_path: newTranscript });
  const r = runHook('memento-activate.js', stdin, {
    CLAUDE_CONFIG_DIR:    dir,
    MEMENTO_PROJECT_HASH: '',
  });

  assert.ok(!r.stdout.includes('[CTX BRIDGE]'),
    'a conversation-hash-keyed file must not be consumed — the bridge is project-scoped now');
  assert.ok(fs.existsSync(convBridgePath),
    'the conversation-hash file is not the bridge path and must be left untouched');
});

// ---------------------------------------------------------------------------
// memento-config.js / activate — project hash derived from the harness transcript
// slug, NOT cwd (v0.8.2 regression)
//
// v0.8.1 keyed the bridge by git-root-of-cwd. cwd drifts between hook invocations,
// and a nested git repo (e.g. a sub-project inside the workspace) makes
// `git rev-parse` resolve a different root than the harness's project — so the
// SessionStart reader and the SessionEnd writer computed DIFFERENT keys and the
// handoff silently failed. v0.8.2 keys by the project-slug parsed from the
// transcript_path, which every hook receives identically regardless of cwd.
// ---------------------------------------------------------------------------

console.log('\nmemento-config.js (transcript-slug project hash)');

test('getProjectHash keys on the transcript project-slug, independent of cwd or the rest of the path', () => {
  const tpA = '/home/alice/.claude/projects/-home-acme/aaaaaaaa.jsonl';
  const tpB = '/var/whatever/deeper/projects/-home-acme/bbbbbbbb.jsonl';
  // Same slug (-home-acme), unrelated surrounding paths → identical hash.
  assert.strictEqual(
    mementoConfig.getProjectHash(tpA),
    mementoConfig.getProjectHash(tpB),
    'hash must derive from the project slug, not the full transcript path');
  // With a slug present, the hash must NOT fall back to the cwd git-root.
  assert.notStrictEqual(
    mementoConfig.getProjectHash(tpA),
    mementoConfig.getProjectHash(),
    'a transcript slug must take precedence over the cwd git-root fallback');
  // Slug extraction edge cases.
  assert.strictEqual(mementoConfig.projectSlugFromTranscript(tpA), '-home-acme');
  assert.strictEqual(mementoConfig.projectSlugFromTranscript('/no/slug/here.jsonl'), null);
  assert.strictEqual(mementoConfig.projectSlugFromTranscript(null), null);
});

test('startup: activate surfaces a bridge keyed by the transcript slug even when the hook cwd git-root differs (nested-repo handoff)', () => {
  const dir = tmpDir();
  // Realistic harness transcript layout: <claudeDir>/projects/<slug>/<uuid>.jsonl
  const realisticTP = path.join(dir, 'projects', '-home-acme', 'new-conv.jsonl');

  const slugHash = mementoConfig.getProjectHash(realisticTP); // what every hook computes
  const cwdHash  = mementoConfig.getProjectHash();            // legacy cwd-git-root value
  assert.notStrictEqual(slugHash, cwdHash,
    'precondition: slug hash must differ from cwd hash so the test can tell which the hook used');

  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const bridgePath = path.join(mementoDir, `ctx_bridge-${slugHash}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    files: ['/src/x.js'], next: 'cross-cwd handoff must work', err: null,
    left: 40000, at: new Date().toISOString(),
  }, null, 2));

  const stdin = JSON.stringify({ source: 'startup', transcript_path: realisticTP });
  const r = runHook('memento-activate.js', stdin, {
    CLAUDE_CONFIG_DIR: dir, MEMENTO_PROJECT_HASH: '', CLAUDE_PROJECT_DIR: '',
  });

  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('[CTX BRIDGE]'),
    'activate must surface the slug-keyed bridge — proving it keyed by transcript slug, not cwd git-root');
  assert.ok(r.stdout.includes('cross-cwd handoff must work'), 'must show next from the slug-keyed bridge');
  assert.ok(!fs.existsSync(bridgePath), 'one-shot: slug-keyed bridge deleted after pickup');
});

test('startup: a bridge at the legacy cwd-git-root key is NOT consumed once the transcript provides a slug', () => {
  const dir = tmpDir();
  const realisticTP = path.join(dir, 'projects', '-home-acme', 'conv2.jsonl');
  const slugHash = mementoConfig.getProjectHash(realisticTP);
  const cwdHash  = mementoConfig.getProjectHash();
  assert.notStrictEqual(slugHash, cwdHash, 'precondition: keys differ');

  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  const legacyPath = path.join(mementoDir, `ctx_bridge-${cwdHash}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    files: [], next: 'legacy cwd-keyed bridge', err: null,
    left: 40000, at: new Date().toISOString(),
  }, null, 2));

  const stdin = JSON.stringify({ source: 'startup', transcript_path: realisticTP });
  const r = runHook('memento-activate.js', stdin, {
    CLAUDE_CONFIG_DIR: dir, MEMENTO_PROJECT_HASH: '',
  });
  assert.ok(!r.stdout.includes('[CTX BRIDGE]'),
    'the slug key is authoritative — a legacy cwd-keyed file is not the bridge path');
  assert.ok(fs.existsSync(legacyPath), 'legacy cwd-keyed file left untouched');
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

test('spike guard fires: past window midpoint + cacheWrite=5000 + no bridge file', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  // 115000 tokens (past window/2=100k, below the 130k primary trigger): cache_write=5000 spike
  const spikeUsage = '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":109999,"cache_creation_input_tokens":5000,"output_tokens":200}}}';
  writeFixtureJsonl(dir, spikeUsage);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[BRIDGE]'), 'spike guard must fire [BRIDGE] past midpoint + spike');
});

test('spike guard skips if bridge file already exists', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  // Same 115000 tokens + spike, but bridge already exists (and primary trigger not reached)
  const spikeUsage = '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":109999,"cache_creation_input_tokens":5000,"output_tokens":200}}}';
  writeFixtureJsonl(dir, spikeUsage);
  // Pre-create bridge file
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'ctx_bridge-testhash.json'), '{"files":[],"next":"test","err":null,"left":40000,"at":"2026-05-23T00:00:00Z"}');
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  // Below the primary trigger; spike guard skips because bridge exists
  assert.ok(!ctx.includes('[BRIDGE]'), 'spike guard must skip if bridge already exists');
});

// ---------------------------------------------------------------------------
// memento-tracker.js — drop detection / [CTX BRIDGE] injection
// ---------------------------------------------------------------------------

console.log('\nmemento-tracker.js (drop detection)');

// Write last_ctx file (fixed per-instance path, no hash) — now stores token total
function writeLastCtxFile(dir, tokens) {
  const mementoDir = path.join(dir, '.memento');
  fs.mkdirSync(mementoDir, { recursive: true });
  fs.writeFileSync(path.join(mementoDir, 'testuser.last_ctx'), String(tokens));
}

function readLastCtxFile(dir) {
  const p = path.join(dir, '.memento', 'testuser.last_ctx');
  try { return parseInt(fs.readFileSync(p, 'utf8').trim(), 10); } catch (e) { return null; }
}

// Write a JSONL with the given absolute total context tokens (200k window unless
// the total exceeds the 1M flip threshold). cache_read carries the bulk, as in real
// sessions, so the heuristic reads a stable number.
function writeJsonlWithTokens(dir, totalTokens) {
  const cacheRead = Math.max(0, totalTokens - 1);
  const usage = `{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":${cacheRead},"cache_creation_input_tokens":0,"output_tokens":200}}}`;
  return writeFixtureJsonl(dir, usage);
}

test('[CTX BRIDGE] injected by tracker when ctx dropped past threshold and bridge exists', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);    // was 156k tokens
  writeJsonlWithTokens(dir, 42000); // now 42k — drop = 114k (compaction)
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('[CTX BRIDGE]'), 'must inject [CTX BRIDGE] on a 114k-token drop');
  assert.ok(ctx.includes('/foo.js'), 'must show files from bridge');
  assert.ok(ctx.includes('run tests'), 'must show next from bridge');
});

test('bridge deleted by tracker after [CTX BRIDGE] injection', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);
  writeJsonlWithTokens(dir, 42000);
  const bridgePath = writeCtxBridgeFile(dir);
  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.ok(!fs.existsSync(bridgePath), 'bridge must be deleted after tracker consumes it');
});

test('[CTX BRIDGE] NOT injected when ctx only grew (no drop)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 60000);     // was 60k tokens
  writeJsonlWithTokens(dir, 90000); // now 90k — grew, no drop
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when ctx grew');
});

test('[CTX BRIDGE] injected via fallback: no last_ctx + well below compaction point', () => {
  // If last_ctx is missing but a bridge exists and usage is well below the compaction
  // point, a post-compaction restart is inferred and the bridge is recovered.
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithTokens(dir, 42000);  // post-compaction usage, far below the 170k point
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('[CTX BRIDGE]'), 'must inject via fallback when no last_ctx and usage is low');
});

test('[CTX BRIDGE] NOT injected: no last_ctx + near compaction point (no compaction)', () => {
  // Fallback only fires when usage is well below the compaction point.
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithTokens(dir, 160000);  // near the 170k point — no compaction inferred
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when usage near compaction (no compaction inferred)');
});

test('[CTX BRIDGE] NOT injected when drop detected but bridge absent', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);
  writeJsonlWithTokens(dir, 42000);
  // No bridge file
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  assert.strictEqual(r.status, 0, 'must exit 0 when bridge absent');
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not inject when bridge absent');
});

test('last_ctx written every turn with current token total', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 0);
  writeV4Journal(dir);
  writeJsonlWithTokens(dir, 90000);
  runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const saved = readLastCtxFile(dir);
  assert.ok(saved !== null, 'last_ctx must be written after each turn');
  assert.ok(Math.abs(saved - 90000) < 5, `saved tokens (${saved}) must be ~90000`);
});

test('drop below threshold (under CTX_DROP_TOKENS) does not trigger [CTX BRIDGE]', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 70000);     // was 70k tokens
  writeJsonlWithTokens(dir, 45000); // now 45k — drop = 25k (below 30k threshold)
  writeCtxBridgeFile(dir);
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(!ctx.includes('[CTX BRIDGE]'), 'must not fire at a 25k-token drop (below threshold)');
});

test('[CTX BRIDGE] shows tokens-left from bridge data', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);
  writeJsonlWithTokens(dir, 42000);
  writeCtxBridgeFile(dir, { left: 38000 });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('38k tokens left'), 'must show tokens-left from bridge');
});

test('[CTX BRIDGE] with no left field → renders "runway unknown" not undefined', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);
  writeJsonlWithTokens(dir, 42000);
  writeCtxBridgeFile(dir, { left: undefined });
  const r = runHook('memento-tracker.js', '{}', { CLAUDE_CONFIG_DIR: dir });
  const ctx = parseAdditionalContext(r.stdout);
  assert.ok(ctx.includes('runway unknown'), 'missing left must render as "runway unknown"');
  assert.ok(!ctx.includes('undefined'), 'must not render undefined');
});

test('[CTX BRIDGE] appears before [MEMENTO] in output (recovery context first)', () => {
  const dir = tmpDir();
  writeTurnSidecar(dir, 1);
  writeV4Journal(dir);
  writeLastCtxFile(dir, 156000);
  writeJsonlWithTokens(dir, 42000);
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
  const existing = '{"files":["/old.js"],"next":"old step","err":null,"left":40000,"at":"2026-05-23T00:00:00Z"}';
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
    '{"files":["/old.js"],"next":"old step","err":null,"left":40000,"at":"2026-05-23T00:00:00Z"}');

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
// REAL cross-session divergence — the actual bug, driven through real code
//
// These do NOT set MEMENTO_PROJECT_HASH (which collapses conversation + project hashes and
// is exactly why the suite missed this twice). Instead they lay down a real stale anchor and
// real transcript files so write-why (CLI, anchor-resolved) and the lifecycle hooks
// (transcript_path-resolved) genuinely compute DIFFERENT conversation hashes — then assert
// the project-scoped last_why fallback still produces a bridge. Each test asserts the
// divergence PRECONDITION so it can't silently degrade into a hashes-agree no-op, and the
// full chain goes red if the fix is reverted.
// ---------------------------------------------------------------------------

console.log('\nreal cross-session divergence (no hash collapse)');

// Run a hook/script with REAL resolution: MEMENTO_PROJECT_HASH disabled so anchor- and
// transcript-based resolution actually drive the conversation hash.
function runReal(scriptName, extraArgs, input, dir, extraEnv = {}) {
  return spawnSync('node', [path.join(HOOKS_DIR, scriptName), ...extraArgs], {
    input,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      MEMENTO_DEBUG: '',
      MEMENTO_INSTANCE_TAG: 'testuser',
      MEMENTO_PROJECT_HASH: '',           // <-- the key difference: do not collapse the hashes
      CLAUDE_CONFIG_DIR: dir,
    }, extraEnv),
    timeout: 5000,
  });
}

function makeTranscript(dir, slug, name) {
  const d = path.join(dir, 'projects', slug);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, '{"type":"x"}\n');
  return p;
}

function setAnchor(dir, jsonlPath) {
  const m = path.join(dir, '.memento');
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(path.join(m, 'testuser.anchor'), jsonlPath);
}

test('precondition: anchor vs transcript yield DIFFERENT conversation hashes, SAME project hash', () => {
  const dir = tmpDir();
  const OLD = makeTranscript(dir, '-home-acme', 'old-convo.jsonl');
  const NEW = makeTranscript(dir, '-home-acme', 'new-convo.jsonl');
  assert.notStrictEqual(getConversationHash(OLD), getConversationHash(NEW), 'conv hashes MUST diverge (else the bug cannot occur)');
  assert.strictEqual(getProjectHash(OLD), getProjectHash(NEW), 'same slug MUST give same projectHash (the property the fix relies on)');
});

test('FULL CHAIN: write-why(anchor) → SessionEnd(transcript) → fresh SessionStart surfaces [CTX BRIDGE]', () => {
  const dir = tmpDir();
  const OLD = makeTranscript(dir, '-home-acme', 'old-convo.jsonl');
  const NEW = makeTranscript(dir, '-home-acme', 'new-convo.jsonl');
  setAnchor(dir, OLD); // stale anchor: write-why will resolve OLD, not the live transcript

  // 1) write-why as the real CLI (no stdin/transcript) → journal under hash(OLD) = the misfile
  const w = runReal('memento-write-why.js', ['shipping the real divergence fix'], '', dir);
  assert.strictEqual(w.status, 0, `write-why must exit 0; stderr: ${w.stderr}`);
  assert.ok(fs.existsSync(path.join(dir, '.memento', `testuser-${getConversationHash(OLD)}.json`)), 'journal filed under hash(OLD)');
  assert.ok(!fs.existsSync(path.join(dir, '.memento', `testuser-${getConversationHash(NEW)}.json`)), 'nothing under hash(NEW) — the divergence is real');
  assert.ok(fs.existsSync(path.join(dir, '.memento', `last_why-${getProjectHash(OLD)}.json`)), 'last_why mirror written under projectHash');

  // 2) SessionEnd with the LIVE transcript NEW → live journal empty → MUST fall back to last_why
  const se = runReal('memento-sessionend.js', [], JSON.stringify({ transcript_path: NEW, reason: 'exit' }), dir);
  assert.strictEqual(se.status, 0);
  const bridgePath = path.join(dir, '.memento', `ctx_bridge-${getProjectHash(NEW)}.json`);
  assert.ok(fs.existsSync(bridgePath), 'bridge MUST be written despite the conversation-hash divergence (red if fix reverted)');
  assert.strictEqual(JSON.parse(fs.readFileSync(bridgePath, 'utf8')).next, 'shipping the real divergence fix');

  // 3) fresh SessionStart on a THIRD (new) conversation → surfaces and consumes the bridge
  const THIRD = makeTranscript(dir, '-home-acme', 'third-convo.jsonl');
  const as = runReal('memento-activate.js', [], JSON.stringify({ source: 'startup', transcript_path: THIRD }), dir);
  assert.strictEqual(as.status, 0);
  assert.ok(as.stdout.includes('[CTX BRIDGE]'), 'restart MUST surface [CTX BRIDGE]');
  assert.ok(as.stdout.includes('shipping the real divergence fix'), 'with the recovered intent');
  assert.ok(!fs.existsSync(bridgePath), 'bridge is one-shot — consumed after read');
});

test('FULL CHAIN via PreCompact: AI extraction fails → minimal fallback uses last_why', () => {
  const dir = tmpDir();
  const OLD = makeTranscript(dir, '-home-acme', 'old-convo.jsonl');
  const NEW = makeTranscript(dir, '-home-acme', 'new-convo.jsonl');
  setAnchor(dir, OLD);
  runReal('memento-write-why.js', ['precompact divergence intent'], '', dir);

  // Fake claude that FAILS so tryWriteAiBridge returns false → minimal (last_why) fallback runs.
  const failClaude = writeFakeClaude(dir, 'boom', { exitCode: 1 });
  const pc = runReal('memento-precompact.js', [], JSON.stringify({ transcript_path: NEW }), dir, { MEMENTO_CLAUDE_BIN: failClaude });
  assert.strictEqual(pc.status, 0);
  const bridgePath = path.join(dir, '.memento', `ctx_bridge-${getProjectHash(NEW)}.json`);
  assert.ok(fs.existsSync(bridgePath), 'precompact must write minimal bridge from last_why on AI failure');
  assert.strictEqual(JSON.parse(fs.readFileSync(bridgePath, 'utf8')).next, 'precompact divergence intent');
});

test('CROSS-PROJECT SAFETY: project A intent never leaks into project B bridge', () => {
  const dir = tmpDir();
  const A_OLD = makeTranscript(dir, '-home-projA', 'a-old.jsonl');
  const B_NEW = makeTranscript(dir, '-home-projB', 'b-new.jsonl');
  assert.notStrictEqual(getProjectHash(A_OLD), getProjectHash(B_NEW), 'precondition: genuinely different projects');
  setAnchor(dir, A_OLD);
  runReal('memento-write-why.js', ['project A private intent'], '', dir); // writes last_why for project A

  // SessionEnd for project B (different slug) with an empty live journal
  const se = runReal('memento-sessionend.js', [], JSON.stringify({ transcript_path: B_NEW }), dir);
  assert.strictEqual(se.status, 0);
  const bBridge = path.join(dir, '.memento', `ctx_bridge-${getProjectHash(B_NEW)}.json`);
  assert.ok(!fs.existsSync(bBridge), 'project B MUST NOT get a bridge sourced from project A intent');
  // and project A's own last_why is intact / correctly scoped
  assert.ok(fs.existsSync(path.join(dir, '.memento', `last_why-${getProjectHash(A_OLD)}.json`)), 'A last_why exists under A projectHash');
});

test('RECENCY: SessionEnd fallback ignores a last_why older than the bridge window', () => {
  const dir = tmpDir();
  const NEW = makeTranscript(dir, '-home-acme', 'new.jsonl');
  // Plant an 8h-old last_why directly under the project hash.
  const lw = path.join(dir, '.memento', `last_why-${getProjectHash(NEW)}.json`);
  fs.mkdirSync(path.dirname(lw), { recursive: true });
  fs.writeFileSync(lw, JSON.stringify({ why: 'ancient intent', at: new Date(Date.now() - 8 * 3600 * 1000).toISOString() }));

  const se = runReal('memento-sessionend.js', [], JSON.stringify({ transcript_path: NEW }), dir);
  assert.strictEqual(se.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.memento', `ctx_bridge-${getProjectHash(NEW)}.json`)), 'stale last_why must not produce a bridge');
});

test('NON-DIVERGENT control: when write-why and the hook agree on hash, normal journal path still works', () => {
  const dir = tmpDir();
  const LIVE = makeTranscript(dir, '-home-acme', 'live.jsonl');
  setAnchor(dir, LIVE);                          // anchor == live transcript → NO divergence
  runReal('memento-write-why.js', ['normal-path intent'], '', dir);
  // journal landed under the LIVE hash (same one SessionEnd will read) → no fallback needed
  assert.ok(fs.existsSync(path.join(dir, '.memento', `testuser-${getConversationHash(LIVE)}.json`)), 'journal under live hash');
  const se = runReal('memento-sessionend.js', [], JSON.stringify({ transcript_path: LIVE }), dir);
  assert.strictEqual(se.status, 0);
  const bridge = JSON.parse(fs.readFileSync(path.join(dir, '.memento', `ctx_bridge-${getProjectHash(LIVE)}.json`), 'utf8'));
  assert.strictEqual(bridge.next, 'normal-path intent', 'normal (non-divergent) path must still bridge from the live journal');
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
