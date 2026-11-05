#!/bin/sh
# Dry-run a set of spoken requests and print plan, timings and the top hits (no card, no clipboard).
cd "$(dirname "$0")/.."
for r in "$@"; do
  echo "== $r"
  bin/wispr-file "$r" --dry-run | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);if(!o.plan){console.log(s);return};console.log(JSON.stringify({terms:o.plan.terms,kind:o.plan.kind,range:o.plan.range&&o.plan.range.label,recent:o.plan.recent,action:o.action,front:o.front&&o.front.name,used:o.used,ms:o.ms,counts:o.counts}));for(const r of o.results||[])console.log("  ",r.score,r.name,"|",r.detail,"|",r.why.join(","),"|",r.image?"img":"-")})'
done
