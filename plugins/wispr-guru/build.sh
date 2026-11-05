#!/bin/sh
# Build helper/guru and package dist/wispr-guru.zip for `claude --plugin-url`. Set UNIVERSAL=1 for arm64+x86_64.
set -eu
cd "$(dirname "$0")"
if [ "${UNIVERSAL:-0}" = 1 ]; then
  T=$(mktemp -d); for a in arm64 x86_64; do swiftc -O -target "$a-apple-macos13" -o "$T/g-$a" helper/guru.swift -framework AppKit -framework SwiftUI; done
  lipo -create -output helper/guru "$T/g-arm64" "$T/g-x86_64"; rm -rf "$T"
elif [ ! -x helper/guru ] || [ helper/guru.swift -nt helper/guru ]; then
  swiftc -O -o helper/guru helper/guru.swift -framework AppKit -framework SwiftUI
fi
mkdir -p dist && rm -f dist/wispr-guru.zip
zip -qr dist/wispr-guru.zip .claude-plugin/plugin.json hooks helper/guru sounds API.md README.md
echo "built dist/wispr-guru.zip"
