#!/bin/sh
# Wispr for Builders, Pack 1: install every mod in this folder.
#
#   ./install.sh                 Claude Code plugins + the mods' shell commands
#   ./install.sh --shell-only    only the shell commands (~/.wispr-*/bin), no Claude Code changes
#   ./install.sh --plugins-only  only the Claude Code plugins
#   ./install.sh wispr-file ...  only the mods you name
#
# Everything runs on this Mac. Nothing here uploads files. Unofficial; not affiliated with Wispr.
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd)
MODE=all
MODS=""
for a in "$@"; do
  case "$a" in
    --shell-only) MODE=shell ;;
    --plugins-only) MODE=plugins ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) MODS="$MODS $a" ;;
  esac
done
# wispr-bridge first: the others register themselves with it.
[ -n "$MODS" ] || MODS="wispr-bridge wispr-file wispr-wish wispr-review wispr-pm wispr-guru wispr-video"

[ "$(uname)" = Darwin ] || { echo "These mods need macOS." >&2; exit 1; }
command -v node >/dev/null || { echo "Needs Node 18+ (brew install node)." >&2; exit 1; }

ok() { printf '  \033[32mok\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!!\033[0m %s\n' "$1"; }

if [ "$MODE" != plugins ]; then
  echo "Shell commands"
  for m in $MODS; do
    bin="$ROOT/plugins/$m/bin/$m"
    if [ -x "$bin" ] && [ "$m" != wispr-video ]; then
      if "$bin" install >/dev/null 2>&1; then ok "$m -> ~/.$m/bin/$m"; else warn "$m install failed: run $bin install"; fi
    fi
  done
  case " $MODS " in *" wispr-review "*)
    "$ROOT/plugins/wispr-review/bin/wispr-review" serve --daemon >/dev/null 2>&1 && ok "wispr-review inbox on 127.0.0.1:4377" || warn "start the review inbox: wispr-review serve --daemon" ;;
  esac
fi

if [ "$MODE" != shell ]; then
  echo "Claude Code plugins"
  if command -v claude >/dev/null; then
    for m in $MODS; do
      if claude plugin install "$m" --marketplace "$ROOT" -y >/dev/null 2>&1; then ok "$m"; else warn "$m: run  claude plugin install $m --marketplace $ROOT"; fi
    done
  else
    warn "claude not found. Install Claude Code, then re-run ./install.sh --plugins-only"
  fi
fi

cat <<'MSG'

Done. Try these with Wispr Flow (hold Fn and talk, into Claude Code or `wispr-bridge ask`):
  "find the GST invoice from October"          wispr-file
  "make this a PDF"                             wispr-wish (select a file in Finder first)
  "park this for the portfolio"                 wispr-pm
  "walk me through making this text bold"       wispr-guru
  /video                                        wispr-video

One manual step for wispr-review: open chrome://extensions, turn on Developer mode,
choose Load unpacked and pick plugins/wispr-review/extension. Then Option+Shift+R on any site.
MSG
