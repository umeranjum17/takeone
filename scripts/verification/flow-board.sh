#!/usr/bin/env bash
# One board action for a `--flow` file, run by the flow-journey: click <text> | click-last <text> |
# drag <text> <text> | type <text> | press <key> | shot <png> | expect <text>. Needs
# CHROME_DEVTOOLS_AXI_BROWSER_URL and CHROME_DEVTOOLS_AXI_SESSION in the environment (set by the journey).
set -euo pipefail
snap=$(mktemp); trap 'rm -f -- "$snap"' EXIT
uid() { chrome-devtools-axi snapshot > "$snap"; pick "$@"; }  # uid <text> [last]: that node's ref from a fresh snapshot
pick() { # pick <text> [last]: that node's ref from the snapshot already in $snap
  python3 - "$snap" "$1" "${2:-}" <<'PY'
import re, sys
text, want, last = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3] == "last"
found = re.findall(r'uid=(\S+)(?: [A-Za-z]+)? "' + re.escape(want) + r'"[ \t]*$', text, re.M)
if not found: raise SystemExit("missing board target: " + want)
print(found[-1] if last else found[0])
PY
}
case "$1" in
  click) chrome-devtools-axi click "@$(uid "$2")" >&2 ;;
  click-last) chrome-devtools-axi click "@$(uid "$2" last)" >&2 ;;
  drag) chrome-devtools-axi snapshot > "$snap"  # both refs from one snapshot, or the second is stale
        from=$(pick "$2" ""); to=$(pick "$3" "")
        chrome-devtools-axi drag "@$from" "@$to" >&2 ;;
  type) chrome-devtools-axi type "$2" >&2 ;;
  press) chrome-devtools-axi press "$2" >&2 ;;
  shot) chrome-devtools-axi screenshot "$2" >&2 ;;
  expect) uid "$2" > /dev/null ;;
  *) echo "flow-board: unknown action $1" >&2; exit 2 ;;
esac
