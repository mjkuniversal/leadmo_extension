#!/bin/bash
# PostToolUse hook: Check if old version zips need archiving after manifest.json edit

# Read the tool input from stdin
INPUT=$(cat)

# Extract file path from the tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run for manifest.json files in leadmo
if [[ ! "$FILE_PATH" =~ leadmo.*manifest\.json ]]; then
    exit 0
fi

# Get the version from the edited manifest
VERSION=$(jq -r '.version' "$FILE_PATH" 2>/dev/null)
if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
    exit 0
fi

# Check for zip files at the root level that don't match current version
LEADMO_DIR="/home/mk/projects/extensions/leadmo"
OLD_ZIPS=()

for zip in "$LEADMO_DIR"/*.zip; do
    [[ -f "$zip" ]] || continue
    BASENAME=$(basename "$zip")
    # Check if this zip doesn't contain the current version
    if [[ ! "$BASENAME" =~ v${VERSION}\.zip$ ]]; then
        OLD_ZIPS+=("$BASENAME")
    fi
done

# If there are old zips, warn the user
if [[ ${#OLD_ZIPS[@]} -gt 0 ]]; then
    echo '{"decision": "block", "reason": "Old version zips found that should be archived: '"$(printf '%s, ' "${OLD_ZIPS[@]}" | sed 's/, $//')"'. Move them to the archive-zips folder before continuing."}'
    exit 0
fi

exit 0
