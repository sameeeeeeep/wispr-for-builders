#!/bin/sh
# Refresh the vendored board dialect from bank-mcp, then package dist/wispr-pm.zip
# for `claude --plugin-dir dist/wispr-pm.zip` (or --plugin-url once hosted).
set -eu
cd "$(dirname "$0")"
[ -f ../bank-mcp/tasks.mjs ] && cp ../bank-mcp/tasks.mjs vendor/tasks.mjs
mkdir -p dist; rm -f dist/wispr-pm.zip
zip -qr dist/wispr-pm.zip .claude-plugin/plugin.json hooks bin lib vendor package.json README.md
echo "built dist/wispr-pm.zip"
