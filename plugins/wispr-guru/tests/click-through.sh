#!/bin/sh
# Real-click test in a sandbox: a TextEdit scratch file. Guru points at TextEdit's Bold button with
# until:{click:true}; the test selects the text, makes ONE real click on Bold, and checks that
#   1. the click went through Guru's highlight to TextEdit (the text is now bold), and
#   2. Guru noticed the click and ended the step by itself ({"reply":"next","auto":true}).
# It waits until you have not touched the keyboard or mouse for 8 s, checks that TextEdit is the window
# under the click point (so the click can only land in the scratch file), and puts the pointer back.
#   sh tests/click-through.sh
set -u
cd "$(dirname "$0")/.."
G=${GURU:-helper/guru}
T=$(mktemp -d); F="$T/guru-click-test.rtf"
printf '{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0\\fs36 Guru click test. Scratch file.}' > "$F"
idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'; }
while [ "$(idle)" -lt 8 ]; do sleep 2; done
open -a TextEdit "$F"; sleep 2.5
osascript -e 'tell application "TextEdit" to activate' -e 'tell application "System Events" to keystroke "a" using command down'
OUT="$T/out.json"
"$G" '{"mode":"step","say":"Click Bold","task":"Click test","target":{"app":"TextEdit","label":"bold","role":"checkbox"},"until":{"click":true},"timeout":25}' > "$OUT" &
GP=$!
sleep 5
R=$(/usr/bin/osascript -l JavaScript tests/click.js "$GP")
echo "click: $R"
wait $GP
FONT=$(osascript -e 'tell application "TextEdit" to get font of text of document 1' 2>/dev/null)
osascript -e 'tell application "TextEdit" to close document 1 saving no' 2>/dev/null
echo "guru said: $(cat "$OUT")"; echo "font now: $FONT"
ok=0
case "$FONT" in *Bold*) echo "ok   the click went through to TextEdit";; *) echo "FAIL the click did not reach TextEdit"; ok=1;; esac
grep -q '"auto":true' "$OUT" && echo "ok   Guru ended the step on the click" || { echo "FAIL Guru did not notice the click"; ok=1; }
rm -rf "$T"; exit $ok
