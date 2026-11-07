#!/usr/bin/env bash
# The glow recipe at --aspect portrait on the demo board, a phone screen and a deck: planned locally, rendered by HyperFrames,
# probed at 1080x1920 and sampled as a contact sheet and the close-up where the cursor presses the real control.
#   TAKEONE_RENDER_WRAP   optional command prefix every render and ffmpeg runs behind (a shared render lock)
set -euo pipefail
out="${1:?evidence folder}"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$out"
run() { ${TAKEONE_RENDER_WRAP:-} "$@"; }
ff() { run ffmpeg -nostdin -y -v error -threads 2 -filter_threads 2 -filter_complex_threads 2 "$@"; }
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"

ff -i resources/demo/tidewater-board.png -vf crop=430:930:0:0 "$work/phone.png" # the board's own left column stands in for a phone screen
run node bin/takeone.mjs motion resources/demo/tidewater-board.png "$work/phone.png" --recipe glow --aspect portrait --title "Meet your crew" \
  --pitch "Plan my week with Chief" --press "Beta feedback" --logo Tidewater --subtitle "Ask. Delegate. Done." --tree "Crew,>Chief,>Scout" \
  --region "316,120,520,520:Plan the launch." --region "868,120,520,520:Track every task." --out "$work/glow"
film="$work/glow/out/motion.mp4"
ffprobe -v error -show_entries stream=width,height,codec_name,duration -of json "$film" > "$out/takeone-glow-portrait-after.json"
grep -q '"width": 1080' "$out/takeone-glow-portrait-after.json" && grep -q '"height": 1920' "$out/takeone-glow-portrait-after.json"
read -r press win <<< "$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])).scenes;let t=0,r=[];for(const c of s){if(c.pattern==="glow-screen")r.push(t);t+=c.d}console.log(r[1]+0.8,r[0]+0.45)' "$work/glow/storyboard.json")"
ff -i "$film" -vf 'fps=2,scale=270:-2,tile=10x2:padding=4' -frames:v 1 "$out/takeone-glow-portrait-after-contact.png"
ff -ss "$press" -i "$film" -frames:v 1 -update 1 "$out/takeone-glow-portrait-after.png"
ff -ss "$win" -i "$film" -frames:v 1 -update 1 "$out/takeone-glow-portrait-after-window.png"
cp "$film" "$out/takeone-glow-portrait-after.mp4"
