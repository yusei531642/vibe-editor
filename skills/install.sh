#!/bin/bash
# vibe-team Skills Pack Installer (Mac/Linux)
set -e

DEST="$HOME/.claude/skills"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS=(
    "vibe-shared-roles"
    "vibe-issue-planner"
    "vibe-autopilot-batch"
    "vibe-fortress-review"
    "vibe-fortress-implement"
)

echo "vibe-team Skills Pack Installer"
echo "Installing to: $DEST"

mkdir -p "$DEST"

for s in "${SKILLS[@]}"; do
    src="$SCRIPT_DIR/$s"
    target="$DEST/$s"
    if [ -d "$target" ]; then
        echo "  Updating: $s"
        rm -rf "$target"
    else
        echo "  Installing: $s"
    fi
    cp -r "$src" "$target"
done

echo ""
echo "Done! ${#SKILLS[@]} skills installed."
echo "Restart Claude Code to load the new skills."
