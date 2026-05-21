#!/bin/zsh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.codex.munger-value-analyzer.plist"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
NODE_PATH="$(command -v node)"

if [[ -z "$NODE_PATH" ]]; then
  echo "Node.js not found. Please install Node.js first."
  exit 1
fi

sed \
  -e "s#__NODE_PATH__#${NODE_PATH}#g" \
  -e "s#__APP_DIR__#${APP_DIR}#g" \
  "$APP_DIR/$PLIST_NAME" > "$APP_DIR/.${PLIST_NAME}.tmp"

mkdir -p "$LAUNCH_AGENTS"
cp "$APP_DIR/.${PLIST_NAME}.tmp" "$LAUNCH_AGENTS/$PLIST_NAME"
rm "$APP_DIR/.${PLIST_NAME}.tmp"

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS/$PLIST_NAME" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$PLIST_NAME"
launchctl kickstart -k "gui/$(id -u)/com.codex.munger-value-analyzer"

echo "Value analyzer is installed and running at http://127.0.0.1:4173"
