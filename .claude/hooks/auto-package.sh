#!/bin/bash
# Auto-package hook for LeadMomentum extension
# PostToolUse hook: runs after Edit/Write on source files
# - Archives old zips (repo root) to LeadMomentum-Chrome/archive-zips/
# - Creates new zips at the repo root named with the manifest version
# - Debounced: max once per 5 minutes

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# Resolve the project root from the harness env, falling back to this
# script's own location (.claude/hooks/ -> repo root) so the hook survives
# repo moves without editing hardcoded paths again.
PROJECT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
STATE_FILE="/tmp/leadmo-auto-package-state"
DEBOUNCE_SECONDS=300

# Only trigger on source files (not zips, archives, docs, .claude)
is_source_file() {
  case "$1" in
    "$PROJECT"/LeadMomentum-Chrome/background.js|\
    "$PROJECT"/LeadMomentum-Chrome/content.js|\
    "$PROJECT"/LeadMomentum-Chrome/manifest.json|\
    "$PROJECT"/LeadMomentum-Chrome/popup/script.js|\
    "$PROJECT"/LeadMomentum-Chrome/popup/index.html|\
    "$PROJECT"/LeadMomentum-Chrome/popup/style.css|\
    "$PROJECT"/LeadMomentum-Chrome/style.css|\
    "$PROJECT"/LeadMomentum-Firefox/background.js|\
    "$PROJECT"/LeadMomentum-Firefox/content.js|\
    "$PROJECT"/LeadMomentum-Firefox/manifest.json|\
    "$PROJECT"/LeadMomentum-Firefox/popup/script.js|\
    "$PROJECT"/LeadMomentum-Firefox/popup/index.html|\
    "$PROJECT"/LeadMomentum-Firefox/popup/style.css|\
    "$PROJECT"/LeadMomentum-Firefox/style.css)
      echo "yes" ;;
    *)
      echo "" ;;
  esac
}

[ -z "$(is_source_file "$FILE_PATH")" ] && exit 0

# Debounce: skip if last package was <5 min ago
if [ -f "$STATE_FILE" ]; then
  LAST_TIME=$(cat "$STATE_FILE")
  NOW=$(date +%s)
  if [ $(( NOW - LAST_TIME )) -lt "$DEBOUNCE_SECONDS" ]; then
    exit 0
  fi
fi

# Read versions from manifests
CR_VER=$(jq -r '.version' "$PROJECT/LeadMomentum-Chrome/manifest.json")
FF_VER=$(jq -r '.version' "$PROJECT/LeadMomentum-Firefox/manifest.json")

ARCHIVE_DIR="$PROJECT/LeadMomentum-Chrome/archive-zips"
mkdir -p "$ARCHIVE_DIR"

# Archive any old-version zips at the repo root (both browsers share one
# archive dir). Store zips live at the root — that is where check-archive.sh
# looks and where store uploads are picked up from.
for zip in "$PROJECT"/LeadMomentum-Chrome\ v*.zip; do
  [ -f "$zip" ] || continue
  case "$zip" in
    *"v${CR_VER}.zip") ;; # current version, skip
    *) mv "$zip" "$ARCHIVE_DIR/" ;;
  esac
done
for zip in "$PROJECT"/LeadMomentum-Firefox\ v*.zip; do
  [ -f "$zip" ] || continue
  case "$zip" in
    *"v${FF_VER}.zip") ;; # current version, skip
    *) mv "$zip" "$ARCHIVE_DIR/" ;;
  esac
done

# Package Chrome (exclude dotfiles, archives at any depth, stray zips)
CR_ZIP="LeadMomentum-Chrome v${CR_VER}.zip"
cd "$PROJECT/LeadMomentum-Chrome"
rm -f "$PROJECT/$CR_ZIP"
zip -qr "$PROJECT/$CR_ZIP" . -x ".*" -x "archive-*" -x "archive-*/*" -x "archive-*/*/*" -x "*.zip"

# Package Firefox
FF_ZIP="LeadMomentum-Firefox v${FF_VER}.zip"
cd "$PROJECT/LeadMomentum-Firefox"
rm -f "$PROJECT/$FF_ZIP"
zip -qr "$PROJECT/$FF_ZIP" . -x ".*" -x "archive-*" -x "archive-*/*" -x "archive-*/*/*" -x "*.zip"

# Record timestamp
date +%s > "$STATE_FILE"

echo "Auto-packaged: Chrome v${CR_VER} | Firefox v${FF_VER} (old zips archived)"
