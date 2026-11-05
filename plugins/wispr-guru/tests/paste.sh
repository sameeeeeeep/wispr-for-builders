#!/bin/sh
# Paste test: puts a long line on the clipboard, opens a card, sends a real ⌘V + ↵ to it, checks the
# card printed the pasted text back. Restores the clipboard. Waits until the keyboard has been idle 8s.
#   tests/paste.sh <binary> '<json>'        e.g. tests/paste.sh helper/guru '{"mode":"present",...}'
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
KT="$HERE/keytest"; [ -x "$KT" ] || swiftc -O -o "$KT" "$HERE/keytest.swift" -framework AppKit
idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'; }
while [ "$(idle)" -lt 8 ]; do sleep 2; done
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
OLD=$(pbpaste 2>/dev/null)
TEXT="${PASTE_TEXT:-1 but make it shorter, and keep the tone friendly — pasted $(date +%s)}"
printf '%s' "$TEXT" | pbcopy
OUT=$(mktemp)
"$@" > "$OUT" & CPID=$!
sleep 1.5
PID=$(pgrep -n -f "$1") ; "$KT" "$PID" ${KT_CLICK:-}
wait $CPID
printf '%s' "$OLD" | pbcopy
echo "card said: $(cat "$OUT")"
grep -q "${EXPECT:-pasted}" "$OUT" && echo "PASTE OK" || echo "PASTE FAILED"
