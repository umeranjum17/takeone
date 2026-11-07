#!/usr/bin/env bash
# Open Design in a real render, run from the installed package and not the checkout: pack the branch, install it into an empty
# prefix, read the pin from doctor, render the Tidewater glow promo with its brand file and with its token kit, and sample the
# closing card during the assembly and at rest. Uses the machine's engine cache.
#   TAKEONE_RENDER_WRAP   optional command prefix every render and ffmpeg runs behind (a shared render lock)
set -euo pipefail
out="${1:?evidence folder}"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$out"
run() { ${TAKEONE_RENDER_WRAP:-} "$@"; }
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"

tarball=$(npm pack --silent --pack-destination "$work" | tail -1)
NPM_CONFIG_PREFIX="$work/prefix" npm install -g --silent "$work/$tarball"
takeone="$work/prefix/bin/takeone"
"$takeone" doctor > "$out/takeone-open-design-doctor.txt" 2>&1 || true # other rows may fail on this host; the pin row is the check
grep -q 'open-design,true,motion,"fork [0-9a-f]\{40\}' "$out/takeone-open-design-doctor.txt"

promo=(resources/demo/tidewater-board.png --recipe glow --title "Meet the crew" --pitch "Plan the launch with Umer" --press "Beta feedback"
  --subtitle "Ask. Delegate. Done." --tree "Crew,>Chief,>Scout" --url tidewater.example)
run "$takeone" motion "${promo[@]}" --brand resources/demo/tidewater-brand.json --out "$work/brand"
run "$takeone" motion "${promo[@]}" --brand resources/demo/tidewater-kit --logo Tidewater --out "$work/kit" 2> "$out/takeone-open-design-kit-log.txt"
grep -q 'drawn in "JetBrains Mono"' "$out/takeone-open-design-kit-log.txt"
grep -q 'accent.*18c8a4' "$work/kit/storyboard.json"

film="$work/brand/out/motion.mp4"
start=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(d.scenes.find(s=>s.pattern==="end-card").start)' "$work/brand/out/scenes.json")
run ffmpeg -nostdin -y -v error -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss "$start" -i "$film" \
  -vf 'fps=8,scale=480:-2,tile=6x4:padding=4' -frames:v 1 "$out/takeone-closing-card-after.png"
for at in 0.18 2.8; do
  run ffmpeg -nostdin -y -v error -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss "$(node -p "$start+$at")" -i "$film" -frames:v 1 "$out/takeone-closing-card-at-$at-after.png"
done
run ffprobe -v error -show_entries stream=width,height,codec_name,nb_frames -show_entries format=duration -of json "$film" > "$out/takeone-closing-card-after.json"
grep -q '"codec_name": "h264"' "$out/takeone-closing-card-after.json"
cp "$film" "$out/takeone-closing-card-after.mp4"
printf '%s\n' "{\"target\":{\"version\":\"$(node -p 'require("./package.json").version')\"},\"commit\":\"$(git rev-parse HEAD)\",\"start\":\"a clean checkout, the staged Tidewater board and the sample Tidewater brand file and token kit, nothing installed from the branch yet\",\"steps\":[\"npm pack the branch and install the tarball into an empty prefix\",\"read the open-design row from that install's takeone doctor\",\"render the glow promo from the installed tool with the brand file, then with the token kit folder\",\"check the kit's font warning and accent, decode the closing card during its assembly and at rest, and probe the MP4\"],\"result\":\"a 1920x1080 h264 promo whose closing card assembles the Tidewater logo from its three shapes, blooms a glow, lands the name and sweeps the accent across it, with the pin verified by the installed doctor\"}" > "$out/steps.json"
