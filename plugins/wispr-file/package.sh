#!/bin/sh
# Zip the plugin without rebuilding the helper. The wispr-bridge library and its wb-card helper are
# vendored into vendor/wispr-bridge so a plugin-url install works without installing the bridge first
# (an installed bridge at ~/.wispr-bridge still wins; see bridge() in lib/find.mjs).
set -eu
cd "$(dirname "$0")"
BRIDGE=${WISPR_BRIDGE_SRC:-../wispr-bridge}
[ -f "$BRIDGE/lib/bridge.mjs" ] && [ -x "$BRIDGE/helper/wb-card" ] || { echo "wispr-bridge not found at $BRIDGE (set WISPR_BRIDGE_SRC)" >&2; exit 1; }
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/vendor/wispr-bridge/lib" "$STAGE/vendor/wispr-bridge/helper" "$STAGE/vendor/wispr-bridge/bin"
cp -R .claude-plugin hooks bin lib package.json README.md tests "$STAGE/"
mkdir -p "$STAGE/helper"; cp helper/wf-clip helper/wf-clip.swift "$STAGE/helper/"
cp "$BRIDGE/lib/bridge.mjs" "$STAGE/vendor/wispr-bridge/lib/"
cp "$BRIDGE/helper/wb-card" "$STAGE/vendor/wispr-bridge/helper/"
cp "$BRIDGE/bin/cli.mjs" "$BRIDGE/bin/wispr-bridge" "$STAGE/vendor/wispr-bridge/bin/" 2>/dev/null || true
[ -f "$BRIDGE/package.json" ] && cp "$BRIDGE/package.json" "$STAGE/vendor/wispr-bridge/"
mkdir -p dist; rm -f dist/wispr-file.zip
(cd "$STAGE" && zip -qry "$OLDPWD/dist/wispr-file.zip" .)
echo "built dist/wispr-file.zip (bridge vendored)"
