#!/usr/bin/env bash
# memento — top-level installer
# Delegates to hooks/install.sh (the canonical standalone installer).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ianreboot/memento/main/install.sh | bash
#
# If you are using the Claude Code plugin system, use:
#   claude plugin install ianreboot/memento

set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
REPO_RAW="https://raw.githubusercontent.com/ianreboot/memento/main/hooks"

# Require node
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' is required to install memento."
  echo "       Install Node.js from https://nodejs.org and re-run."
  exit 1
fi

echo "Installing memento..."
mkdir -p "$HOOKS_DIR"

HOOK_FILES=("package.json" "memento-config.js" "memento-debug.js" "memento-activate.js" "memento-tracker.js" "memento-precompact.js" "memento-sessionend.js" "memento-write-why.js" "install.sh")

for f in "${HOOK_FILES[@]}"; do
  curl -fsSL "$REPO_RAW/$f" -o "$HOOKS_DIR/$f"
  echo "  Downloaded: $HOOKS_DIR/$f"
done

chmod +x "$HOOKS_DIR/install.sh"

# Install SKILL.md — Claude's journaling instructions (how to write entries)
SKILLS_DIR="$CLAUDE_DIR/skills/memento"
mkdir -p "$SKILLS_DIR"
curl -fsSL "https://raw.githubusercontent.com/ianreboot/memento/main/skills/memento/SKILL.md" -o "$SKILLS_DIR/SKILL.md"
echo "  Downloaded: $SKILLS_DIR/SKILL.md"

# Run the canonical installer (now local)
bash "$HOOKS_DIR/install.sh" "$@"
