#!/usr/bin/env bash
# memento — standalone hook installer for Claude Code
#
# Use this if you are NOT using the Claude Code plugin system.
# If you installed via "claude plugin install", you do not need this script.
#
# Usage:
#   bash hooks/install.sh
#   bash hooks/install.sh --force    # re-install over existing installation
#   bash hooks/install.sh --uninstall
#
# What this does:
#   1. Copies hook files into ~/.claude/hooks/
#   2. Wires SessionStart and UserPromptSubmit hooks in ~/.claude/settings.json
#   3. Backs up settings.json before modifying it
#
# What this does NOT do:
#   - Modify any project files
#   - Require root or sudo
#   - Send any data anywhere

set -euo pipefail

FORCE=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --force|-f)     FORCE=1     ;;
    --uninstall|-u) UNINSTALL=1 ;;
  esac
done

# Require node — used to merge hook config into settings.json safely
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' is required to install memento hooks."
  echo "       Install Node.js from https://nodejs.org and re-run."
  exit 1
fi

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"

# Resolve script location — works both from repo clone and via curl|bash
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
fi

REPO_RAW="https://raw.githubusercontent.com/ianreboot/memento/main/hooks"
HOOK_FILES=("package.json" "memento-config.js" "memento-debug.js" "memento-activate.js" "memento-tracker.js" "memento-precompact.js" "install.sh")

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  echo "Uninstalling memento hooks..."

  for f in "${HOOK_FILES[@]}"; do
    if [ -f "$HOOKS_DIR/$f" ]; then
      rm "$HOOKS_DIR/$f"
      echo "  Removed: $HOOKS_DIR/$f"
    fi
  done

  SKILLS_DIR="$CLAUDE_DIR/skills/memento"
  if [ -f "$SKILLS_DIR/SKILL.md" ]; then
    rm "$SKILLS_DIR/SKILL.md"
    rmdir "$SKILLS_DIR" 2>/dev/null || true
    echo "  Removed: $SKILLS_DIR/SKILL.md"
  fi

  if [ -f "$SETTINGS" ]; then
    cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
    MEMENTO_SETTINGS="$SETTINGS" node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync(process.env.MEMENTO_SETTINGS, 'utf8'));
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact']) {
        if (Array.isArray(s.hooks && s.hooks[event])) {
          s.hooks[event] = s.hooks[event].filter(e =>
            !(e.hooks && e.hooks.some(h => h.command && h.command.includes('memento')))
          );
        }
      }
      fs.writeFileSync(process.env.MEMENTO_SETTINGS, JSON.stringify(s, null, 2) + '\n');
      console.log('  Hooks removed from settings.json (backup at settings.json.bak)');
    " 2>/dev/null || echo "  Could not update settings.json — remove memento hooks manually."
  fi

  echo ""
  echo "Done. Restart Claude Code to complete uninstall."
  echo ""
  echo "Journal files (if any) remain at $CLAUDE_DIR/.memento/ — review and remove manually if desired."
  exit 0
fi

# ---------------------------------------------------------------------------
# Check if already installed
# ---------------------------------------------------------------------------
if [ "$FORCE" -eq 0 ]; then
  ALL_FILES=1
  for f in "${HOOK_FILES[@]}"; do
    [ -f "$HOOKS_DIR/$f" ] || { ALL_FILES=0; break; }
  done

  HOOKS_WIRED=0
  if [ "$ALL_FILES" -eq 1 ] && [ -f "$SETTINGS" ]; then
    MEMENTO_SETTINGS="$SETTINGS" node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync(process.env.MEMENTO_SETTINGS, 'utf8'));
      const has = (ev) => Array.isArray(s.hooks && s.hooks[ev]) &&
        s.hooks[ev].some(e => e.hooks && e.hooks.some(h => h.command && h.command.includes('memento')));
      process.exit(has('SessionStart') && has('UserPromptSubmit') ? 0 : 1);
    " >/dev/null 2>&1 && HOOKS_WIRED=1
  fi

  if [ "$ALL_FILES" -eq 1 ] && [ "$HOOKS_WIRED" -eq 1 ]; then
    echo "memento is already installed."
    echo "  Re-run with --force to overwrite: bash hooks/install.sh --force"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
echo "Installing memento..."
mkdir -p "$HOOKS_DIR"

for f in "${HOOK_FILES[@]}"; do
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$f" ] && [ "$SCRIPT_DIR" != "$HOOKS_DIR" ]; then
    cp "$SCRIPT_DIR/$f" "$HOOKS_DIR/$f"
  else
    curl -fsSL "$REPO_RAW/$f" -o "$HOOKS_DIR/$f"
  fi
  echo "  Installed: $HOOKS_DIR/$f"
done

# Install SKILL.md — Claude's journaling instructions (how to write entries)
SKILLS_DIR="$CLAUDE_DIR/skills/memento"
mkdir -p "$SKILLS_DIR"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../skills/memento/SKILL.md" ] && [ "$SCRIPT_DIR" != "$HOOKS_DIR" ]; then
  cp "$SCRIPT_DIR/../skills/memento/SKILL.md" "$SKILLS_DIR/SKILL.md"
else
  curl -fsSL "https://raw.githubusercontent.com/ianreboot/memento/main/skills/memento/SKILL.md" -o "$SKILLS_DIR/SKILL.md"
fi
echo "  Installed: $SKILLS_DIR/SKILL.md"

# Wire hooks into settings.json
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"

MEMENTO_SETTINGS="$SETTINGS" MEMENTO_HOOKS_DIR="$HOOKS_DIR" MEMENTO_FORCE="$FORCE" node -e "
  const fs    = require('fs');
  const sp    = process.env.MEMENTO_SETTINGS;
  const hd    = process.env.MEMENTO_HOOKS_DIR;
  const force = process.env.MEMENTO_FORCE === '1';
  const s     = JSON.parse(fs.readFileSync(sp, 'utf8'));
  if (!s.hooks) s.hooks = {};

  // --force: strip all existing memento entries before re-wiring so that
  // stale entries from a previous install (e.g., pointing to a different path)
  // do not block the hasHook() guard and silently survive the upgrade.
  if (force) {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreCompact']) {
      if (Array.isArray(s.hooks[ev])) {
        s.hooks[ev] = s.hooks[ev].filter(e =>
          !(e.hooks && e.hooks.some(h => h.command && h.command.includes('memento')))
        );
      }
    }
  }

  const hasHook = (ev) =>
    Array.isArray(s.hooks[ev]) &&
    s.hooks[ev].some(e => e.hooks && e.hooks.some(h => h.command && h.command.includes('memento')));

  if (!s.hooks.SessionStart)     s.hooks.SessionStart    = [];
  if (!s.hooks.UserPromptSubmit) s.hooks.UserPromptSubmit = [];
  if (!s.hooks.PreCompact)       s.hooks.PreCompact       = [];

  let wired = false;
  if (!hasHook('SessionStart')) {
    s.hooks.SessionStart.push({ hooks: [{
      type: 'command',
      command: 'node \"' + hd + '/memento-activate.js\"',
      timeout: 5000,
      statusMessage: 'Restoring task context...',
    }]});
    wired = true;
  }

  if (!hasHook('UserPromptSubmit')) {
    s.hooks.UserPromptSubmit.push({ hooks: [{
      type: 'command',
      command: 'node \"' + hd + '/memento-tracker.js\"',
      timeout: 3000,
    }]});
    wired = true;
  }

  if (!hasHook('PreCompact')) {
    s.hooks.PreCompact.push({ hooks: [{
      type: 'command',
      command: 'node \"' + hd + '/memento-precompact.js\"',
      timeout: 5000,
    }]});
    wired = true;
  }

  fs.writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  if (wired) console.log('  Hooks wired in settings.json (backup at settings.json.bak)');
"

# Post-install verification: confirm settings.json hook commands point to installed path.
# This catches the upgrade scenario where stale paths survive the wiring step.
echo ""
echo "Verifying installation..."
MEMENTO_SETTINGS="$SETTINGS" MEMENTO_HOOKS_DIR="$HOOKS_DIR" node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.env.MEMENTO_SETTINGS, 'utf8'));
  const hd = process.env.MEMENTO_HOOKS_DIR;
  const check = (ev) =>
    Array.isArray(s.hooks && s.hooks[ev]) &&
    s.hooks[ev].some(e => e.hooks && e.hooks.some(h =>
      h.command && h.command.includes('memento') && h.command.includes(hd)
    ));
  const ss = check('SessionStart');
  const up = check('UserPromptSubmit');
  const pc = check('PreCompact');
  console.log('  ' + (ss ? 'ok' : 'FAIL') + '  SessionStart      -> ' + hd);
  console.log('  ' + (up ? 'ok' : 'FAIL') + '  UserPromptSubmit  -> ' + hd);
  console.log('  ' + (pc ? 'ok' : 'FAIL') + '  PreCompact        -> ' + hd);
  if (!ss || !up || !pc) {
    console.log('');
    console.log('  Hook wiring may be incorrect.');
    console.log('  Try: bash hooks/install.sh --force');
    process.exit(1);
  }
" 2>/dev/null

echo ""
echo "Done. Restart Claude Code to activate memento."
echo ""
echo "Journal location: $CLAUDE_DIR/.memento/"
echo "To uninstall:     bash hooks/install.sh --uninstall"
