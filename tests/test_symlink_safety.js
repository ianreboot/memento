#!/usr/bin/env node
// Symlink safety tests for readJournal and writeJournal (v0.4.0)
// Verifies that the hooks refuse to read/write through symlinks at the journal path.
'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { readJournal, writeJournal } = require('../hooks/memento-config.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memento-symlink-'));
}

// v0.4.0 journal template
function v4Journal() {
  return { why: 'symlink test', when: new Date().toISOString(), why_history: [] };
}

console.log('\nsymlink safety');

test('readJournal refuses a symlink at the journal path', () => {
  const dir     = tmpDir();
  const target  = path.join(dir, 'target.json');
  const symlink = path.join(dir, 'journal.json');
  try {
    fs.writeFileSync(target, JSON.stringify(v4Journal(), null, 2), { mode: 0o600 });
    fs.symlinkSync(target, symlink);
    const result = readJournal(symlink);
    assert.strictEqual(result, null, 'readJournal must return null for a symlink');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal refuses to write when journal path is a symlink', () => {
  const dir     = tmpDir();
  const target  = path.join(dir, 'sensitive.txt');
  const symlink = path.join(dir, 'journal.json');
  try {
    fs.writeFileSync(target, 'original content', { mode: 0o600 });
    fs.symlinkSync(target, symlink);
    writeJournal(symlink, v4Journal());
    // Target must be unchanged — writeJournal must have refused
    const content = fs.readFileSync(target, 'utf8');
    assert.strictEqual(content, 'original content', 'writeJournal must not clobber symlink target');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeJournal succeeds for a normal (non-symlink) path', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'journal.json');
    writeJournal(journalPath, v4Journal());
    assert.ok(fs.existsSync(journalPath), 'journal file must exist after normal write');
    const loaded = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(loaded.why, 'symlink test');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('readJournal succeeds for a normal (non-symlink) path', () => {
  const dir = tmpDir();
  try {
    const journalPath = path.join(dir, 'journal.json');
    fs.writeFileSync(journalPath, JSON.stringify(v4Journal(), null, 2), { mode: 0o600 });
    const loaded = readJournal(journalPath);
    assert.ok(loaded !== null, 'readJournal must succeed for normal file');
    assert.strictEqual(loaded.why, 'symlink test');
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
