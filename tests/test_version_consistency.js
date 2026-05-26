#!/usr/bin/env node
// Version consistency test — all four version locations must match.
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

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

// ---------------------------------------------------------------------------
// Read all four version sources
// ---------------------------------------------------------------------------

const pluginJson      = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
const marketplaceJson = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
const activateJs      = fs.readFileSync(path.join(ROOT, 'hooks/memento-activate.js'), 'utf8');
const trackerJs       = fs.readFileSync(path.join(ROOT, 'hooks/memento-tracker.js'), 'utf8');

const pluginVersion      = pluginJson.version;
const marketplaceVersion = marketplaceJson.plugins[0].version;

const activateMatch  = activateJs.match(/^\/\/ memento — SessionStart hook \(v([^)]+)\)/m);
const trackerMatch   = trackerJs.match(/^\/\/ memento — UserPromptSubmit hook \(v([^)]+)\)/m);
const activateVersion  = activateMatch  ? activateMatch[1]  : null;
const trackerVersion   = trackerMatch   ? trackerMatch[1]   : null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('plugin.json version is present', () => {
  assert.ok(pluginVersion, 'plugin.json missing "version" field');
});

test('marketplace.json version is present', () => {
  assert.ok(marketplaceVersion, 'marketplace.json plugins[0] missing "version" field');
});

test('memento-activate.js version comment is present', () => {
  assert.ok(activateVersion,
    'memento-activate.js line 2 does not match expected pattern: // memento — SessionStart hook (vX.Y.Z)');
});

test('memento-tracker.js version comment is present', () => {
  assert.ok(trackerVersion,
    'memento-tracker.js line 2 does not match expected pattern: // memento — UserPromptSubmit hook (vX.Y.Z)');
});

test('plugin.json and marketplace.json versions match', () => {
  assert.strictEqual(pluginVersion, marketplaceVersion,
    `plugin.json (${pluginVersion}) !== marketplace.json (${marketplaceVersion})`);
});

test('plugin.json and memento-activate.js versions match', () => {
  assert.strictEqual(pluginVersion, activateVersion,
    `plugin.json (${pluginVersion}) !== memento-activate.js comment (${activateVersion})`);
});

test('plugin.json and memento-tracker.js versions match', () => {
  assert.strictEqual(pluginVersion, trackerVersion,
    `plugin.json (${pluginVersion}) !== memento-tracker.js comment (${trackerVersion})`);
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
