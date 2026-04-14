#!/bin/bash
# Auto-package hook for LeadMomentum extension
# PostToolUse hook: runs after Edit/Write on source files
# - Archives old zips to archive-zips/
# - Creates new zips named with current version from manifest.json
# - Debounced: max once per 5 minutes

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

PROJECT="/home/mk/projects/extensions/leadmo"
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

CR_DIR="$PROJECT/LeadMomentum-Chrome"
FF_DIR="$PROJECT/LeadMomentum-Firefox"

# Archive old Chrome zips (any zip in the directory that isn't the current version)
for zip in "$CR_DIR"/LeadMomentum-Chrome\ v*.zip; do
  [ -f "$zip" ] || continue
  case "$zip" in
    *"v${CR_VER}.zip") ;; # current version, skip
    *) mv "$zip" "$CR_DIR/archive-zips/" ;;
  esac
done

# Archive old Firefox zips
for zip in "$FF_DIR"/LeadMomentum-Firefox\ v*.zip; do
  [ -f "$zip" ] || continue
  case "$zip" in
    *"v${FF_VER}.zip") ;; # current version, skip
    *) mv "$zip" "$FF_DIR/archive-zips/" ;;
  esac
done

# Package Chrome
CR_ZIP="LeadMomentum-Chrome v${CR_VER}.zip"
cd "$CR_DIR"
rm -f "$CR_ZIP"
zip -qr "$CR_ZIP" . -x ".*" -x "archive-*/*" -x "*.zip"

# Package Firefox
FF_ZIP="LeadMomentum-Firefox v${FF_VER}.zip"
cd "$FF_DIR"
rm -f "$FF_ZIP"
zip -qr "$FF_ZIP" . -x ".*" -x "archive-*/*" -x "*.zip"

# Record timestamp
date +%s > "$STATE_FILE"

echo "Auto-packaged: Chrome v${CR_VER} | Firefox v${FF_VER} (old zips archived)"
