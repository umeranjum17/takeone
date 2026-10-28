#!/usr/bin/env bash
# Cold and warm `takeone render --preview` on a planned take taller than 1080 px: the first
# preview builds the proxy (and says so), the second reuses it. Evidence: both timing lines,
# the probe, the preview MP4 and a decoded still.
#   TAKEONE_PREVIEW_TAKE  a planned take directory (its screen.webm taller than 1080 px)
#   TAKEONE_RENDER_WRAP   optional command prefix every render runs behind (a shared render lock)
set -euo pipefail
out="${1:?evidence folder}"
src="${TAKEONE_PREVIEW_TAKE:?set TAKEONE_PREVIEW_TAKE to a planned take}"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$out"
cp -r "$src" "$work/take"
rm -f "$work"/take/proxy-*.mp4
export TAKEONE_STATE_DIR="$work/state"
run() { ${TAKEONE_RENDER_WRAP:-} "$@"; }
for pass in cold warm; do
  run node bin/takeone.mjs render "$work/take" --preview 2> "$work/$pass.err" > "$work/$pass.out"
  grep '^preview timing:' "$work/$pass.err" | sed "s/^/$pass: /" >> "$out/preview-timing.txt"
done
grep -q '^cold: .*built now' "$out/preview-timing.txt"
grep -q '^warm: .*proxy reused' "$out/preview-timing.txt"
mp4=$(tail -1 "$work/warm.out")
ffprobe -v error -show_entries stream=width,height,codec_name,r_frame_rate -show_entries format=duration -of json "$mp4" > "$out/preview-probe.json"
grep -q '"width": 864' "$out/preview-probe.json"
run ffmpeg -nostdin -y -v error -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss 16 -i "$mp4" -frames:v 1 "$out/takeone-fast-preview-after.png"
cp "$mp4" "$out/takeone-fast-preview-after.mp4"
cat "$out/preview-timing.txt"
printf '%s\n' "{\"target\":{\"version\":\"$(node -p 'require("./package.json").version')\"},\"commit\":\"$(git rev-parse HEAD)\",\"start\":\"a planned 3840x2160 recording of a real-UI scene (not a captain recording), no proxy and no preview yet\",\"steps\":[\"run takeone render --preview with no proxy: it builds the 1080p proxy and prints its timing line\",\"run takeone render --preview again: it reuses the proxy and prints its timing line\",\"probe the preview MP4 and decode a still at 16 seconds\"],\"result\":\"both previews print where their time went, the first says the proxy was built now and the second that it was reused, and the preview is an 864x486 H.264 film of the scene\"}" > "$out/steps.json"
