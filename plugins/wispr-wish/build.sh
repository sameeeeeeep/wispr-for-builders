#!/bin/sh
# Package dist/wispr-wish.zip for `claude --plugin-dir dist/wispr-wish.zip` (or --plugin-url once hosted).
set -eu
cd "$(dirname "$0")"
mkdir -p dist; rm -f dist/wispr-wish.zip
zip -qr dist/wispr-wish.zip .claude-plugin/plugin.json hooks bin lib apps vendor package.json README.md
echo "built dist/wispr-wish.zip"
