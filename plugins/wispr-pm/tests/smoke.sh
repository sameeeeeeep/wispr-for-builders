#!/bin/sh
# Headless smoke test: temp home + temp copy of a board + fake claude. No cards, no network, no real boards touched.
set -eu
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '#!/bin/sh\ncat >/dev/null; echo "fake claude ok"\n' > "$T/claude"; chmod +x "$T/claude"
printf '# t\n\n## Next up\n- [ ] Ship the notch fix #switchboard status:review\n- [ ] Old thing #switchboard\n' > "$T/sb.md"
export WISPR_PM_HOME="$T/home" WISPR_PM_SB_BOARD="$T/sb.md" WISPR_PM_CLAUDE="$T/claude" WISPR_PM_NOCARD=1
P=./bin/wispr-pm; fail=0
check() { if printf '%s' "$2" | grep -q "$3"; then echo "ok   $1"; else echo "FAIL $1: $2"; fail=1; fi; }
check "parse park"    "$($P parse 'park fix the hero on mobile for the portfolio')" '"op": "park"'
check "parse next"    "$($P parse "what's next on nailinit")" '"project": "nailinit"'
check "parse thread"  "$($P parse 'start a thread for the hero fix')" '"text": "hero fix"'
check "park"          "$($P 'park fix the hero on mobile for the portfolio')" '"added": true'
check "dedupe"        "$($P 'park fix the hero on mobile for the portfolio')" 'duplicate'
check "shared board"  "$($P 'add a pricing faq to switchboard')" 'sb.md'
check "tag written"   "$(cat $T/sb.md)" 'a pricing faq #switchboard status:backlog'
check "next"          "$($P "what's next on the portfolio")" 'fix the hero on mobile'
check "waiting"       "$($P "what's waiting on me")" 'Ship the notch fix'
check "waiting needs" "$($P "what's waiting on me")" '"needs": "needs your review"'
check "show me"       "$($P parse 'show me')" '"op": "waiting"'
check "pill text"     "$(node -e "import('./lib/pm.mjs').then(m=>console.log(m.pillText(3), '|', m.clip('OS UI/UX is bad and the user flow needs a full pass', 30)))")" '3 waiting · tap to see | OS UI/UX is bad and the user…'
check "snooze"        "$($P snooze 30)" 'snoozedUntil'
check "snoozed pill"  "$($P notch)" '"snoozed": true'
check "thread"        "$($P 'start a thread for the hero on mobile on portfolio')" '"started": true'
sleep 2
check "thread→review" "$($P board portfolio)" 'review'
check "done"          "$($P 'mark the hero on mobile done on portfolio')" '"changed": true'
check "park beats done" "$($P parse "park write the readme for it's done")" '"op": "park"'
mkdir -p "$T/proj/café" "$T/proj/my weird proj (1)"
check "unicode board"  "$(WISPR_PM_PROJECTS_ROOT=$T/proj $P 'park buy beans for café')" 'café.md'
check "punct strip"    "$(WISPR_PM_PROJECTS_ROOT=$T/proj $P parse 'park buy milk for my weird proj (1)')" '"text": "buy milk"'
rm -f "$T/home/projects.json"; $P parse 'park x for portfolio' >/dev/null
[ -f "$T/home/projects.json" ] && { echo "FAIL parse wrote projects.json"; fail=1; } || echo "ok   parse writes nothing"
exit $fail
