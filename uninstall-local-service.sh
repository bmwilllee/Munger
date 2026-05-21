#!/bin/zsh
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.codex.munger-value-analyzer.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Value analyzer local service removed."
