#!/bin/sh
# Build helper/guru and package dist/wispr-guru.zip for `claude --plugin-url`. Set UNIVERSAL=1 for arm64+x86_64.
# The card is drawn with the shared Wispr theme: WisprTheme.swift (from ../wispr-theme, or the copy in
# helper/ when building from the zip's source) is concatenated ahead of helper/guru.swift, and its
# fonts/ (Figtree, EB Garamond, SIL OFL) ship in the zip.
set -eu
cd "$(dirname "$0")"
THEME=${WISPR_THEME:-../wispr-theme}
if [ -f "$THEME/WisprTheme.swift" ]; then
  cp -p "$THEME/WisprTheme.swift" helper/WisprTheme.swift
  rm -rf fonts; mkdir -p fonts; cp "$THEME"/fonts/*.ttf "$THEME"/fonts/OFL-*.txt fonts/
fi
[ -f helper/WisprTheme.swift ] && [ -d fonts ] || { echo "WisprTheme.swift / fonts not found (set WISPR_THEME)" >&2; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat helper/WisprTheme.swift helper/guru.swift > "$T/main.swift"
if [ "${UNIVERSAL:-0}" = 1 ]; then
  for a in arm64 x86_64; do swiftc -O -target "$a-apple-macos13" -o "$T/g-$a" "$T/main.swift" -framework AppKit -framework SwiftUI; done
  lipo -create -output helper/guru "$T/g-arm64" "$T/g-x86_64"
elif [ ! -x helper/guru ] || [ helper/guru.swift -nt helper/guru ] || [ helper/WisprTheme.swift -nt helper/guru ]; then
  swiftc -O -o helper/guru "$T/main.swift" -framework AppKit -framework SwiftUI
fi
mkdir -p dist && rm -f dist/wispr-guru.zip
zip -qr dist/wispr-guru.zip .claude-plugin/plugin.json hooks helper/guru helper/guru.swift helper/WisprTheme.swift fonts sounds tools/make-sounds.py API.md README.md
echo "built dist/wispr-guru.zip"
