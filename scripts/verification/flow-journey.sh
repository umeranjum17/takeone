#!/usr/bin/env bash
# The flow journey on a real recorded screen: one `--flow` file drives the board while the recorder films it.
#
# Records the staged Tidewater board (scripts/e2e/scene.html, fictional content) on its own Xvfb display in a
# throwaway Chromium profile with `takeone capture record --source x11:<display> --flow flow.json`. Nobody
# runs `takeone stop`: the flow's steps use the board, then the recording stops itself. The take is then
# planned and rendered on the recorded engine (no account, key or network, 0 model calls).
#
#   scripts/verification/flow-journey.sh <work-dir> <evidence-dir>
#
# Set TAKEONE_RENDER_WRAP to the assigned memory gate and render slot, as the core journey does.
set -euo pipefail
root=$(pwd -P)
work=$(mkdir -p "$1" && cd "$1" && pwd -P)
evidence=$(mkdir -p "$2" && cd "$2" && pwd -P)
log="$work/commands.log"
: > "$log"
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"
mkdir -p "$TAKEONE_DIR" "$TAKEONE_STATE_DIR"
run() { echo "\$ $*" >> "$log"; "$@" >> "$log" 2>&1; }

xvfb_pid='' chrome_pid=''
cleanup() {
  [ -n "$chrome_pid" ] && { kill "$chrome_pid" 2>/dev/null || true; wait "$chrome_pid" 2>/dev/null || true; }
  [ -n "$xvfb_pid" ] && { kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; }
  return 0
}
trap cleanup EXIT

Xvfb -displayfd 1 -screen 0 2560x1440x24 -nolisten tcp -extension GLX > "$work/display.txt" 2> "$work/xvfb.log" &
xvfb_pid=$!
for _ in $(seq 100); do [ -s "$work/display.txt" ] && break; sleep .1; done
display=$(head -1 "$work/display.txt")
[ -n "$display" ] || { echo "flow-journey: no Xvfb display (see $work/xvfb.log)" >&2; exit 1; }
profile=$(mktemp -d "$work/browser-profile-XXXXXX")
DISPLAY=":$display" chromium --ozone-platform=x11 --no-sandbox --no-first-run --no-default-browser-check \
  --disable-gpu --disable-dev-shm-usage --user-data-dir="$profile" --remote-debugging-port=0 \
  --window-position=0,0 --window-size=2560,1440 --force-device-scale-factor=1 --kiosk about:blank \
  > "$work/chrome.log" 2>&1 &
chrome_pid=$!
for _ in $(seq 200); do [ -s "$profile/DevToolsActivePort" ] && break; sleep .1; done
port=$(head -1 "$profile/DevToolsActivePort")
[ -n "$port" ] || { echo "flow-journey: no DevTools port (see $work/chrome.log)" >&2; exit 1; }
export CHROME_DEVTOOLS_AXI_SESSION="flow-journey-$$" CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$port"
board="$root/scripts/verification/flow-board.sh"
chrome-devtools-axi open "file://$root/scripts/e2e/scene.html" > /dev/null 2>&1
sleep 3

# The flow file a lead agent would write: use the board, check what it took, hold, and stop by itself.
python3 - "$work/flow.json" "$board" "$work/source-board.png" <<'PY'
import json, sys
out, board, shot = sys.argv[1:4]
b = lambda *a: {"run": ["bash", board, *a]}
w = lambda ms: {"wait_ms": ms}
steps = [w(2000), b("click", "Fix export timeout"), w(2000), b("click", "+ New task"), w(1000),
         b("type", "Draft launch announcement"), b("press", "Tab"),
         b("type", "Two short paragraphs and a link to the release notes."), w(1000),
         b("click", "Normal"), w(1000), b("click-last", "High"), w(1000), b("click", "Create task"), w(3000),
         b("expect", "Draft launch announcement"), b("drag", "Update pricing page", "Beta feedback survey"), w(3000),
         b("click", "⋯"), w(1000), b("click", "Export board as CSV"), w(3000), b("shot", shot)]
json.dump({"steps": steps}, open(out, "w"), indent=1)
PY
cp "$work/flow.json" "$evidence/takeone-flow-file.json"

echo "\$ node bin/takeone.mjs capture record --source x11::$display --root $TAKEONE_DIR --state-dir $TAKEONE_STATE_DIR --max-seconds 120 --flow $work/flow.json" >> "$log"
DISPLAY=":$display" node bin/takeone.mjs capture record --source "x11::$display" \
  --root "$TAKEONE_DIR" --state-dir "$TAKEONE_STATE_DIR" --max-seconds 120 --flow "$work/flow.json" > "$work/capture.log" 2> "$work/capture.err" \
  || { cat "$work/capture.err" "$work/capture.log" >&2; exit 1; }
take=$(python3 - "$work/capture.log" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    if line.startswith('{') and json.loads(line).get('event') == 'done': print(json.loads(line)['take'])
PY
)
[ -n "$take" ] || { echo "flow-journey: the recorder wrote no done event (see $work/capture.log)" >&2; exit 1; }
echo "recorded take: $take (stopped by the flow; no takeone stop was run)" >> "$log"
grep -c '^flow step' "$work/capture.err" > "$work/steps-run.txt" || true

wrap=${TAKEONE_RENDER_WRAP:-}
run $wrap scripts/verification/recorded-engine.sh "$work/engine" \
  node bin/takeone.mjs make "$take" --goal "Creating a task and moving it across a project board"
id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$take/take.json")
film="$take/out/$id.mp4"
[ -s "$film" ] || { echo "flow-journey: no film at $film" >&2; exit 1; }

for f in take.json analysis/plan.json; do cp "$take/$f" "$evidence/takeone-flow-$(basename "$f")"; done
cp "$work/capture.log" "$evidence/takeone-flow-record.log"
cp "$work/capture.err" "$evidence/takeone-flow-steps.log"
probe() { ffprobe -v warning -show_entries stream=codec_name,width,height -show_entries format=duration,size -of json "$1" > "$2" 2>> "$log"; }
probe "$take/screen.webm" "$evidence/takeone-flow-record-probe.json"
probe "$film" "$evidence/takeone-flow-render-probe.json"
cp "$work/source-board.png" "$evidence/takeone-flow-source-board.png"
ff() { run $wrap ffmpeg -nostdin -y -threads 2 -filter_threads 2 -filter_complex_threads 2 "$@"; }
ff -ss 5 -i "$take/screen.webm" -frames:v 1 -update 1 "$evidence/takeone-flow-record-frame.png"
ff -ss 27 -i "$take/screen.webm" -frames:v 1 -update 1 "$evidence/takeone-flow-record-end-frame.png"
ff -ss 5 -i "$film" -frames:v 1 -update 1 "$evidence/takeone-flow-render-frame.png"
ff -i "$film" -an -vf "fps=1,scale=480:-2,tile=5x4" -frames:v 1 -update 1 "$evidence/takeone-flow-render-sheet.png"
cp "$film" "$evidence/takeone-flow-render.mp4"
cp "$log" "$evidence/takeone-flow-commands.log"
( cd "$evidence" && sha256sum takeone-flow-render.mp4 takeone-flow-render-frame.png takeone-flow-record-frame.png takeone-flow-record-end-frame.png > SHA256SUMS )
echo "flow journey: recorded $id with --flow, rendered $film"
