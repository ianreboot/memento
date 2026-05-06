#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== memento test suite ==="
echo ""

echo "--- test_journal_utils ---"
node tests/test_journal_utils.js

echo ""
echo "--- test_hooks ---"
node tests/test_hooks.js

echo ""
echo "--- test_symlink_safety ---"
node tests/test_symlink_safety.js

echo ""
echo "All tests passed."
