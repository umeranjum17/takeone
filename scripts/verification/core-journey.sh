#!/usr/bin/env bash
# The core journey on a real recorded screen: record -> stop -> make -> render.
#
# Records the staged Tidewater board (scripts/e2e/scene.html, fictional content) on its own
# Xvfb display in a throwaway Chromium profile, stops it with `takeone stop`, then plans and
# renders that take. `capture record --source x11:<display>` is the recorder with an explicit
# X display instead of the desktop portal: the shipped `takeone record` needs a person to
# click a portal consent, which a script cannot grant. Planning runs against the recorded
# engine, so the run needs no account, no key and no network.
#
#   scripts/verification/core-journey.sh <work-dir> <evidence-dir>
#
# <work-dir> holds the take, the scratch state and the command log; <evidence-dir> receives
# the proof files only (frames, sheet, probes, plan, logs). Set TAKEONE_RENDER_WRAP to the
# assigned memory gate and render slot, as the done-done journeys do.
set -euo pipefail
root=$(pwd -P)
work=$(mkdir -p "$1" && cd "$1" && pwd -P)
evidence=$(mkdir -p "$2" && cd "$2" && pwd -P)
log="$work/commands.log"
: > "$log"
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"
mkdir -p "$TAKEONE_DIR" "$TAKEONE_STATE_DIR"

run() { # run <command...>: keep the full output in the command log
  echo "\$ $*" >> "$log"
  "$@" >> "$log" 2>&1
}
runq() { # runq <command...>: the same, keeping only the first 3 output lines (a browser step prints its whole page snapshot)
  echo "\$ $*" >> "$log"
  "$@" 2>&1 | sed -n '1,3p' >> "$log"
}

xvfb_pid='' chrome_pid=''
cleanup() {
  [ -n "$chrome_pid" ] && { kill "$chrome_pid" 2>/dev/null || true; wait "$chrome_pid" 2>/dev/null || true; }
  [ -n "$xvfb_pid" ] && { kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; }
  return 0
}
trap cleanup EXIT

# 1. A display of our own, with the fixture board fullscreen on it.
Xvfb -displayfd 1 -screen 0 2560x1440x24 -nolisten tcp -extension GLX > "$work/display.txt" 2> "$work/xvfb.log" &
xvfb_pid=$!
for _ in $(seq 100); do [ -s "$work/display.txt" ] && break; sleep .1; done
display=$(head -1 "$work/display.txt")
[ -n "$display" ] || { echo "core-journey: no Xvfb display (see $work/xvfb.log)" >&2; exit 1; }
profile=$(mktemp -d "$work/browser-profile-XXXXXX")
DISPLAY=":$display" chromium --ozone-platform=x11 --no-sandbox --no-first-run --no-default-browser-check \
  --disable-gpu --disable-dev-shm-usage --user-data-dir="$profile" --remote-debugging-port=0 \
  --window-position=0,0 --window-size=2560,1440 --force-device-scale-factor=1 --kiosk about:blank \
  > "$work/chrome.log" 2>&1 &
chrome_pid=$!
for _ in $(seq 200); do [ -s "$profile/DevToolsActivePort" ] && break; sleep .1; done
port=$(head -1 "$profile/DevToolsActivePort")
[ -n "$port" ] || { echo "core-journey: no DevTools port (see $work/chrome.log)" >&2; exit 1; }
browser() { CHROME_DEVTOOLS_AXI_SESSION="core-journey-$$" CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$port" chrome-devtools-axi "$@"; }
runq browser open "file://$root/scripts/e2e/scene.html"
sleep 3

uid() { # uid <visible text>...: those accessibility nodes, one ref per line, from one snapshot; "last:<text>" takes the last match
  browser snapshot > "$work/snapshot.log"
  python3 - "$work/snapshot.log" "$@" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
for want in sys.argv[2:]:
    last = want.startswith('last:')
    found = re.findall(r'uid=(\S+)(?: [A-Za-z]+)? "' + re.escape(want[5:] if last else want) + r'"[ \t]*$', text, re.M)
    if not found: raise SystemExit('missing fixture target: ' + want)
    print(found[-1] if last else found[0])
PY
}

# 2. Record it, before the drive, as a person would.
echo "\$ node bin/takeone.mjs capture record --source x11::$display --root $TAKEONE_DIR --state-dir $TAKEONE_STATE_DIR --max-seconds 90" >> "$log"
DISPLAY=":$display" node bin/takeone.mjs capture record --source "x11::$display" \
  --root "$TAKEONE_DIR" --state-dir "$TAKEONE_STATE_DIR" --max-seconds 90 > "$work/capture.log" 2>&1 &
capture_pid=$!
for _ in $(seq 300); do grep -q '"event":"recording"' "$work/capture.log" 2>/dev/null && break; kill -0 "$capture_pid" 2>/dev/null || { cat "$work/capture.log"; exit 1; }; sleep .1; done
grep -q '"event":"recording"' "$work/capture.log"

# 3. Use the board: open a task, type into it, set priority, create it, drag a card, scroll.
sleep 2
runq browser click "@$(uid 'Fix export timeout')"
sleep 2
runq browser click "@$(uid '+ New task')"
sleep 1
runq browser type "Draft launch announcement"  # the dialog focuses Title itself, as for a person
sleep 1
runq browser press Tab
runq browser type "Two short paragraphs and a link to the release notes."
sleep 1
runq browser click "@$(uid 'Normal')"
sleep 1
runq browser click "@$(uid 'last:High')"
sleep 1
runq browser click "@$(uid 'Create task')"
sleep 3
uid 'Draft launch announcement' > /dev/null   # the new card carries what was typed, not "Untitled"
[ "$(grep -c ' "High"[ \t]*$' "$work/snapshot.log")" -ge 2 ] || { echo "core-journey: the new task did not take priority High" >&2; exit 1; }
{ read -r from; read -r to; } < <(uid 'Update pricing page' 'Beta feedback survey')
runq browser drag "@$from" "@$to"
sleep 3
runq browser click "@$(uid '⋯')"
sleep 1
runq browser click "@$(uid 'Export board as CSV')"
sleep 3
runq browser screenshot "$work/source-board.png"

# 4. Stop it with the shipped stop command, exactly as a person would.
run node bin/takeone.mjs stop
wait "$capture_pid"
take=$(python3 - "$work/capture.log" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    if line.startswith('{') and json.loads(line).get('event') == 'done': print(json.loads(line)['take'])
PY
)
[ -n "$take" ] || { echo "core-journey: the recorder wrote no done event (see $work/capture.log)" >&2; exit 1; }
echo "recorded take: $take" >> "$log"

# 5. Plan and render it, offline: no account, no key, no network.
wrap=${TAKEONE_RENDER_WRAP:-}
run $wrap scripts/verification/recorded-engine.sh "$work/engine" \
  node bin/takeone.mjs make "$take" --goal "Creating a task and moving it across a project board"
id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$take/take.json")
film="$take/out/$id.mp4"
[ -s "$film" ] || { echo "core-journey: no film at $film" >&2; exit 1; }

# 6. Evidence: the recording, the film, decoded frames, plan, probes and the command log.
for f in take.json analysis/plan.json analysis/beats.json analysis/decisions.jsonl; do
  [ -f "$take/$f" ] && cp "$take/$f" "$evidence/takeone-core-$(basename "$f")"
done
cp "$work/capture.log" "$evidence/takeone-core-record.log"
probe() { # probe <media> <evidence file>: ffprobe's JSON on stdout, its warnings in the command log
  echo "\$ ffprobe (codec, size, duration) $1 > $2" >> "$log"
  ffprobe -v warning -show_entries stream=codec_name,width,height -show_entries format=duration,size -of json "$1" > "$2" 2>> "$log"
}
probe "$take/screen.webm" "$evidence/takeone-core-record-probe.json"
probe "$film" "$evidence/takeone-core-render-probe.json"
cp "$work/source-board.png" "$evidence/takeone-core-source-board.png"
run $wrap ffmpeg -nostdin -y -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss 5 -i "$take/screen.webm" -frames:v 1 -update 1 "$evidence/takeone-core-record-frame.png"
run $wrap ffmpeg -nostdin -y -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss 5 -i "$film" -frames:v 1 -update 1 "$evidence/takeone-core-render-frame.png"
run $wrap ffmpeg -nostdin -y -threads 2 -filter_threads 2 -filter_complex_threads 2 -i "$film" -an -vf "fps=1,scale=480:-2,tile=5x4" -frames:v 1 -update 1 "$evidence/takeone-core-render-sheet.png"
cp "$film" "$evidence/takeone-core-render.mp4"
cp "$log" "$evidence/takeone-core-commands.log"
( cd "$evidence" && sha256sum takeone-core-render.mp4 takeone-core-render-frame.png takeone-core-record-frame.png > SHA256SUMS )
echo "core journey: recorded $id, rendered $film"
