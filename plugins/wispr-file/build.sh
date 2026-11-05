#!/bin/sh
# Build helper/wf-clip (universal unless ARCH=arm64), sign it if the Developer ID is present, and
# package dist/wispr-file.zip for `claude --plugin-dir dist/wispr-file.zip` (or --plugin-url once hosted).
set -eu
cd "$(dirname "$0")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ARCHS=${ARCH:-"arm64 x86_64"}
for a in $ARCHS; do
  swiftc -O -target "$a-apple-macos13" -o "$TMP/wf-clip-$a" helper/wf-clip.swift -framework AppKit
done
lipo -create -output helper/wf-clip $(for a in $ARCHS; do echo "$TMP/wf-clip-$a"; done)
IDENTITY="Developer ID Application: STAYOFT VENTURES PRIVATE LIMITED (55354KFTHU)"
if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --options runtime --timestamp --identifier ai.thelastprompt.wf-clip --sign "$IDENTITY" helper/wf-clip
fi
./package.sh
