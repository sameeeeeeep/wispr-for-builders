#!/bin/sh
# Build helper/wb-card (universal), sign it if a Developer ID is available, and package
# dist/wispr-bridge.zip for `claude --plugin-dir dist/wispr-bridge.zip` (or --plugin-url once hosted).
# ARCH=arm64 ./build.sh for a fast local build (swiftc takes ~3 min per arch on this Mac).
# The card is drawn with the shared Wispr theme: ../wispr-theme/WisprTheme.swift is concatenated ahead
# of helper/wb-card.swift, and its fonts/ (Figtree, EB Garamond, SIL OFL) ship in the zip.
set -eu
cd "$(dirname "$0")"
THEME=${WISPR_THEME:-../wispr-theme}
[ -f "$THEME/WisprTheme.swift" ] || { echo "WisprTheme.swift not found in $THEME (set WISPR_THEME)" >&2; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat "$THEME/WisprTheme.swift" helper/wb-card.swift > "$TMP/main.swift"
ARCHS=${ARCH:-"arm64 x86_64"}
for a in $ARCHS; do
  swiftc -O -target "$a-apple-macos13" -o "$TMP/wb-card-$a" "$TMP/main.swift" -framework AppKit -framework SwiftUI
done
lipo -create -output helper/wb-card $(for a in $ARCHS; do echo "$TMP/wb-card-$a"; done)
IDENTITY="Developer ID Application: STAYOFT VENTURES PRIVATE LIMITED (55354KFTHU)"
if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --options runtime --timestamp --identifier ai.thelastprompt.wb-card --sign "$IDENTITY" helper/wb-card
fi
rm -rf fonts; mkdir -p fonts; cp "$THEME"/fonts/*.ttf "$THEME"/fonts/OFL-*.txt fonts/
mkdir -p dist; rm -f dist/wispr-bridge.zip
zip -qr dist/wispr-bridge.zip .claude-plugin/plugin.json hooks bin lib helper/wb-card fonts package.json API.md README.md
echo "built dist/wispr-bridge.zip"
