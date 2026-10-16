#!/usr/bin/env bash
# Negative controls for the visual defect pass: break a copy of a good pass's film with ffmpeg and
# check it against that cell's own sidecars. Every control must exit 1 and name its defect; the good
# films are the pass itself (its pass.log). See README.md.
#
#   visual-controls.sh <good-pass-dir> <out-dir> [--work <that pass's work dir>] [--letterbox-take <dir>]
#
# --letterbox-take names a take rendered by a letterboxing phone build (whole screen shown
# with matte bars inside the phone frame): its own film must FAIL on blank-strip, proving
# the check catches bars inside a device frame. Every other control breaks a good film.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 2 ] || { sed -n '6p' "$0" >&2; exit 2; }
pass=$(cd "$1" && pwd); out=$2; shift 2
work=$pass/work
[ "${1:-}" = --work ] && { work=$2; shift 2; }
letterbox=
[ "${1:-}" = --letterbox-take ] && { letterbox=$2; shift 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)
read -r -a gate <<< "${TAKEONE_GATE:-}"
run() { "${gate[@]}" "$@"; }
log=$out/controls.log; : > "$log"
fail=0

# A fact of a good cell's result at its first hold that has it, e.g. `fact desktop-dark element.rect`.
fact() {
  node -e 'const r = require(process.argv[1]).results.filter(x => x.facts.hold);
    const [path, want] = [process.argv[2].split("."), process.argv[3]];
    const get = f => path.reduce((o, k) => o?.[k], f);
    const hit = r.find(x => get(x.facts) !== undefined && (!want || x.facts.element?.name === want));
    const v = get(hit.facts); console.log(typeof v === "object" ? [v.x, v.y, v.w, v.h].map(Math.round).join(" ") : v);' \
    "$pass/$1.json" "$2" "${3:-}"
}
control() { # <name> <cell> <theme> <expected check> <ffmpeg -vf or -filter_complex graph>
  local name=$1 c=$2 th=$3 want=$4 graph=$5 broken=$out/control-$1.mp4 rc=0
  run ffmpeg -nostdin -v error -y -threads 2 -filter_threads 2 -filter_complex_threads 2 -i "$pass/$c.mp4" \
    -filter_complex "$graph" -an -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p "$broken"
  run node "$here/visual-check.ts" "$work/takes/$c" --name "control-$name" --out "$out" --theme "$th" \
    --film "$broken" --ref "$pass/$c.mp4" > "$out/control-$name.log" 2>&1 || rc=$?
  local fired; fired=$(grep -o '^FAIL [^ ]* t=[^ ]* [a-z-]*' "$out/control-$name.log" | awk '{print $4}' | sort | uniq -c | awk '{printf "%s%s=%s", sep, $2, $1; sep=" "}')
  if [ "$rc" = 1 ] && grep -q "^FAIL [^ ]* t=[^ ]* $want " "$out/control-$name.log"; then v=PASS; else v=FAIL; fail=1; fi
  echo "$v control $name ($c, $graph): exit $rc, expected $want; fired: ${fired:-nothing}" | tee -a "$log"
}

read -r ex ey ew eh <<< "$(fact desktop-dark element.rect b2/z1)"
read -r cx cy cw ch <<< "$(fact desktop-dark shown)"
read -r px py pw ph <<< "$(fact portrait-dark shown)"
read -r mx my mw mh <<< "$(fact motion-dark shown)"
font=$(cd "$here/../.." && pwd)/resources/fonts/Inter-SemiBold.ttf

control stretch desktop-dark midnight stretch "scale=iw*1.04:ih,crop=1920:1080"
control stretch-phone font-dark midnight stretch "scale=iw*1.04:ih,crop=1080:1920"
control strip-film-edge desktop-light paper blank-strip "drawbox=x=0:y=0:w=48:h=ih:color=black:t=fill"
control strip-in-screen portrait-dark midnight blank-strip "drawbox=x=$px:y=$py:w=32:h=$ph:color=black:t=fill"
# A real defect inside the phone screen still fails: a bar over the motion hero's
# settled left edge (starting before the edge and spanning every hold's full height,
# so the push drift between sampled holds cannot uncover it) must read as a
# screen-edge blank strip.
control strip-in-phone motion-dark midnight blank-strip "drawbox=x=$((mx - 8)):y=$((my - 20)):w=56:h=$((mh + 40)):color=black:t=fill"
control clipped-text font-dark midnight clipped-text "crop=iw*0.7:ih*0.7:iw*0.3:ih*0.15,scale=1080:1920"
control overlap desktop-dark midnight overlap \
  "drawbox=x=$((ex - 60)):y=$((ey - 16)):w=$((ew + 200)):h=$((eh + 32)):color=0x23242b:t=fill,drawtext=fontfile='$font':text='New caption':x=$((ex - 40)):y=$((ey + 4)):fontsize=30:fontcolor=white"
# The card's picture slides up 30 px inside the card: the top toolbar the last beat holds leaves the frame.
control off-screen desktop-dark midnight off-screen \
  "split[a][b];[b]crop=$cw:$((ch - 30)):$cx:$((cy + 30))[c];[a][c]overlay=$cx:$cy"
if [ -n "$letterbox" ]; then # the letterboxing phone build's own film must fail on blank-strip
  film=$(ls "$letterbox"/out/*.mp4 | head -1); rc=0
  run node "$here/visual-check.ts" "$letterbox" --name control-letterbox --out "$out" --theme midnight \
    --film "$film" > "$out/control-letterbox.log" 2>&1 || rc=$?
  if [ "$rc" = 1 ] && grep -q "^FAIL [^ ]* t=[^ ]* blank-strip " "$out/control-letterbox.log"; then v=PASS; else v=FAIL; fail=1; fi
  echo "$v control letterbox ($film): exit $rc, expected blank-strip" | tee -a "$log"
fi
echo "$([ $fail = 0 ] && echo PASS || echo FAIL) controls: every control must fail its own check" | tee -a "$log"
exit $fail
