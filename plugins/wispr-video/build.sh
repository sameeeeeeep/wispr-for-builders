#!/bin/sh
# Package dist/wispr-video.zip for `claude --plugin-url`.
set -eu
cd "$(dirname "$0")"
mkdir -p dist && rm -f dist/wispr-video.zip
zip -qr dist/wispr-video.zip .claude-plugin README.md app bin commands skills server -x '*/__pycache__/*' '*.pyc' '*.DS_Store' 'app/.test-*'
echo "built dist/wispr-video.zip ($(du -h dist/wispr-video.zip | cut -f1))"
