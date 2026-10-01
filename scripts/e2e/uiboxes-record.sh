#!/usr/bin/env bash
# Run only inside the task's heavy-lock wrapper. Own virtual display/profile.
set -euo pipefail
root=$(pwd -P)
dir="$root/tmp/uiboxes-proof"
evidence="$root/tmp/evidence/t1-uiboxes"
mkdir -p "$dir" "$evidence"
browser_profile=$(mktemp -d "$dir/browser-profile-XXXXXX")
browser_session="takeone-uiboxes-record-$(date +%s)"
Xvfb -displayfd 1 -screen 0 2560x1440x24 -nolisten tcp -extension GLX > "$dir/display.txt" 2> "$dir/xvfb.log" &
xvfb_pid=$!
chrome_pid=''
capture_pid=''
bridge_ready=0
cleanup() {
  if [ -n "$capture_pid" ]; then kill -INT "$capture_pid" 2>/dev/null || true; wait "$capture_pid" 2>/dev/null || true; fi
  if [ -n "$chrome_pid" ]; then kill "$chrome_pid" 2>/dev/null || true; wait "$chrome_pid" 2>/dev/null || true; fi
  if [ "$bridge_ready" = 1 ]; then browser stop >/dev/null 2>&1 || true; fi
  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
for n in $(seq 1 100); do [ -s "$dir/display.txt" ] && break; sleep .1; done
display=$(head -1 "$dir/display.txt")
DISPLAY=":$display" chromium --ozone-platform=x11 --no-sandbox --no-first-run --no-default-browser-check \
  --disable-gpu --disable-dev-shm-usage --user-data-dir="$browser_profile" --remote-debugging-port=0 --window-position=0,0 \
  --window-size=2560,1440 --force-device-scale-factor=1 --kiosk about:blank > "$dir/chrome.log" 2>&1 &
chrome_pid=$!
for n in $(seq 1 100); do [ -s "$browser_profile/DevToolsActivePort" ] && break; sleep .1; done
port=$(head -1 "$browser_profile/DevToolsActivePort")
browser() { CHROME_DEVTOOLS_AXI_SESSION="$browser_session" CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$port" chrome-devtools-axi "$@"; }
browser open "file://$root/scripts/e2e/scene.html" > "$dir/browser-open.log"
bridge_ready=1
browser eval '() => { for (const kind of ["mousedown","mouseup"]) document.addEventListener(kind, e => { if (e.target.closest(".card")) e.stopPropagation(); }, true); return {width: innerWidth, height: innerHeight}; }' > "$dir/viewport.log"
# Click cards without mutating their demo status: this fixture deliberately tests
# the unchanged surface case. The actual browser input and video are recorded.
browser screenshot "$evidence/takeone-uiboxes-source-board.png" > "$dir/board-shot.log"
browser eval '() => { window.proofStart = Date.now(); window.proofEvents = [{k:"win",t:0,cls:"chromium",title:"Tidewater board",rect:[0,0,2560,1440]}]; document.addEventListener("mousemove", e => proofEvents.push({k:"ptr", t:Date.now()-proofStart, x:e.clientX, y:e.clientY})); for (const kind of ["mousedown","mouseup"]) document.addEventListener(kind, e => { proofEvents.push({k:"ptr",t:Date.now()-proofStart,x:e.clientX,y:e.clientY}); proofEvents.push({k:"btn",t:Date.now()-proofStart,b:"left",down:kind==="mousedown"}); },true); return "events ready"; }' > "$dir/event-start.log"
DISPLAY=":$display" node bin/takeone.mjs capture record --source "x11::$display" \
  --root "$dir/recorded" --state-dir "$dir/capture-state" --events none --max-seconds 60 > "$dir/capture.log" 2>&1 &
capture_pid=$!
for n in $(seq 1 200); do
  rg -q '"event":"recording"' "$dir/capture.log" && break
  kill -0 "$capture_pid" 2>/dev/null || { cat "$dir/capture.log"; exit 1; }
  sleep .1
done
rg -q '"event":"recording"' "$dir/capture.log"
click_text() {
  browser snapshot > "$dir/snapshot.log"
  ref=$(python - "$dir/snapshot.log" "$1" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(r'uid=([^ ]+) (?:StaticText|heading) "' + re.escape(sys.argv[2]) + '"', text)
if not match: raise RuntimeError('missing fixture target ' + sys.argv[2])
print(match.group(1))
PY
)
  browser click "@$ref" > "$dir/click.log"
}
sleep 3
click_text 'Fix export timeout'
sleep 4
click_text 'Update pricing page'
sleep 4
click_text 'Activity'
sleep 4
click_text '+ New task'
sleep 1
browser eval '() => { document.activeElement.blur(); document.querySelector("#title").value="Draft launch announcement"; document.querySelector("#notes").value="Two short paragraphs and a link to the release notes."; return "demo fields ready"; }' > "$dir/dialog-fields.log"
sleep 1
browser screenshot "$evidence/takeone-uiboxes-source-dialog.png" > "$dir/dialog-shot.log"
click_text 'Notes'
sleep 4
kill -INT "$capture_pid"
wait "$capture_pid"
capture_pid=''
browser eval 'JSON.stringify({start:proofStart,events:proofEvents})' > "$dir/events-result.log"
python - "$dir" "$evidence" <<'PY'
import datetime, json, pathlib, shutil, sys
d = pathlib.Path(sys.argv[1])
evidence = pathlib.Path(sys.argv[2])
done = next(json.loads(line) for line in (d/'capture.log').read_text().splitlines() if line.startswith('{') and json.loads(line).get('event') == 'done')
recorded = pathlib.Path(done['take'])
meta = json.loads((recorded/'take.json').read_text())
assert meta['stream'] == dict(w=2560,h=1440), meta['stream']
rtp = int((recorded/'frames.tsv').read_text().split('\t')[0])
video_start = rtp / 90 + meta['offset_ms']
capture_start = datetime.datetime.fromisoformat(meta['started_at'].replace('Z','+00:00')).timestamp()*1000
shutil.copy(recorded/'take.json', evidence/'takeone-uiboxes-recorder-meta.json')
shutil.copy(recorded/'frames.tsv', evidence/'takeone-uiboxes-recorder-frames.tsv')
shutil.copy(recorded/'screen.webm', d/'screen.webm')
line = next(s for s in (d/'events-result.log').read_text().splitlines() if s.startswith('result: '))
value = line.removeprefix('result: ')
while isinstance(value, str): value = json.loads(value)
shift = value['start'] - capture_start - video_start
value = value['events']
for event in value: event['t'] = max(0, event['t'] + shift)
(d/'events.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in value))
clicks = []
pointer = None
for event in value:
    if event['k'] == 'ptr': pointer = event
    if event['k'] == 'btn' and event['down']: clicks.append([event['t'],pointer['x'],pointer['y']])
assert len(clicks) == 5, clicks
(d/'proof-clicks.json').write_text(json.dumps([*clicks[:3],clicks[4]]))
(d/'frames.tsv').write_text('0\t0\n')
meta.update(id='takeone-uiboxes', scale=1,offset_ms=0,pointer='hyprland',events='own')
meta.pop('trim',None)
(d/'take.json').write_text(json.dumps(meta))
PY
cp "$dir/screen.webm" "$evidence/takeone-uiboxes-recording.webm"
cp "$dir/events.jsonl" "$evidence/takeone-uiboxes-events.jsonl"
node scripts/e2e/uiboxes-proof.ts
