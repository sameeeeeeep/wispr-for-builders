#!/bin/sh
# dist/wispr-review-extension.zip (Load unpacked after unzipping, or drag into chrome://extensions) and
# dist/wispr-review.zip (the whole Claude Code plugin, extension included).
set -e
cd "$(dirname "$0")"
rm -f dist/*.zip
(cd extension && zip -qr ../dist/wispr-review-extension.zip . -x '.*')
zip -qr dist/wispr-review.zip .claude-plugin hooks skills bin extension README.md -x '*/.*'
ls -la dist
