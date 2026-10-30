#!/usr/bin/env bash
# A take dressed in a product's own brand: the same headless board take rendered without --brand and
# with it, a decoded still of each, the stage pixel the brand sets, and the refusal an unbundled
# typeface name gets. The brand file carries a font *file* (Fraunces SemiBold) as its display face, so
# the render's own font directory supplies it.
#   TAKEONE_RENDER_WRAP   optional command prefix every capture, render and ffmpeg runs behind (a shared render lock)
#   rehearsal             a fast rehearsal: the same two films at 864x486, ultrafast, never the proof
set -euo pipefail
out="${1:?evidence folder}"
rehearsal="${2:-}"
# Both films take the same size and preset, so the pair stays comparable. The larger caption size keeps
# the title big enough to read its face in a still.
small=(--set caption_size=56)
[ -z "$rehearsal" ] || small+=(--set out_w=864 --set out_h=486 --set preset=ultrafast)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$out"
run() { ${TAKEONE_RENDER_WRAP:-} "$@"; }
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"
at=1.5
still() { run ffmpeg -nostdin -y -v error -threads 2 -filter_threads 2 -filter_complex_threads 2 -ss "$at" -i "$1" -frames:v 1 "$2"; }
# The 1x1 stage pixel at 6,6 as "r g b" decimals (the stage corner is brand background plus grain).
pixel() { run ffmpeg -nostdin -v error -i "$1" -vf crop=1:1:6:6 -f rawvideo -pix_fmt rgb24 - 2>/dev/null | od -An -tu1 | tr -s ' ' | sed 's/^ //;s/ $//'; }
# The faces the renderer set its text in, read back from the ASS it wrote beside the film.
faces() { grep -o '\\fn[A-Za-z0-9 ]*' "$1" | sed 's/^\\fn//' | sort -u | paste -sd ',' -; }
film() { ls "$1"/out/*.mp4 | grep -v -- '-preview' | head -1; }

# The realistic scene, not a flat fixture: the staged Tidewater board at 2x, captured headless.
run node scripts/headless-scene.mjs "$work/scene" --aspect=landscape --scale=2
# One title and one caption, so both typefaces a brand sets are on screen in every film below.
node -e 'const fs = require("fs"), f = process.argv[1], t = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...t, title: "Meet the crew", captions: [{ t: 0.6, d: 9, text: "Plan the launch on one board" }] }));' "$work/scene/take.json"
run node bin/takeone.mjs make "$work/scene" --no-ai "${small[@]}"
cp "$(film "$work/scene")" "$work/plain.mp4"
printf 'without --brand: %s\n' "$(faces "$work/scene/captions.ass")" > "$out/takeone-brand-take-faces.txt"

# The brand file: a light cream stage with the board's own ink and teal, and the display face carried as
# a font file. A take takes any background lightness (the glow recipe refuses a light one).
node -e 'const fs = require("fs"), path = require("path");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    name: "Tidewater",
    colors: { background: "#f4f2ee", surface: "#ffffff", foreground: "#1d1f23", border: "#dcd7cb", accent: "#0f766e" },
    typography: { display: { family: "Fraunces SemiBold", file: path.resolve("resources/fonts/Fraunces-SemiBold.ttf") }, body: "Manrope" },
  }, null, 1));' "$work/brand.json"
run node bin/takeone.mjs render "$work/scene" --brand "$work/brand.json" "${small[@]}"
cp "$(film "$work/scene")" "$work/branded.mp4"
printf 'with --brand: %s\n' "$(faces "$work/scene/captions.ass")" >> "$out/takeone-brand-take-faces.txt"
cat "$out/takeone-brand-take-faces.txt"
# The brand's own typeface is the one the renderer set the title in, and the faces are not the defaults.
grep -q '^with --brand: .*Fraunces SemiBold' "$out/takeone-brand-take-faces.txt"
grep -q '^with --brand: .*Manrope Medium' "$out/takeone-brand-take-faces.txt"
grep -q '^without --brand: .*Inter Bold' "$out/takeone-brand-take-faces.txt"

still "$work/plain.mp4" "$out/takeone-brand-take-before.png"
still "$work/branded.mp4" "$out/takeone-brand-take-after.png"
before=$(pixel "$out/takeone-brand-take-before.png")
after=$(pixel "$out/takeone-brand-take-after.png")
printf 'still at %ss, the 1x1 stage pixel at 6,6 as r g b: without --brand %s, with --brand %s (the brand background #f4f2ee is 244 242 238)\n' \
  "$at" "$before" "$after" > "$out/takeone-brand-take-pixels.txt"
cat "$out/takeone-brand-take-pixels.txt"
test "$before" != "$after"
node -e 'const [r, g, b] = process.argv[1].split(" ").map(Number);
  if (Math.abs(r - 244) > 12 || Math.abs(g - 242) > 12 || Math.abs(b - 238) > 12) {
    console.error(`the branded stage pixel is ${r} ${g} ${b}, not the brand background #f4f2ee`); process.exit(1); }' "$after"

# A typeface TakeOne does not bundle and the brand does not carry: an explicit error naming it.
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ typography: { display: "BrandSans" } }))' "$work/unknown-font-brand.json"
status=0
node bin/takeone.mjs render "$work/scene" --brand "$work/unknown-font-brand.json" > "$out/takeone-brand-unknown-font.txt" 2>&1 || status=$?
printf 'exit status: %s\n' "$status" >> "$out/takeone-brand-unknown-font.txt"
cat "$out/takeone-brand-unknown-font.txt"
test "$status" != 0
grep -q '"BrandSans" is not a font TakeOne bundles (no fallback is used)' "$out/takeone-brand-unknown-font.txt"

run ffprobe -v error -show_entries stream=width,height,codec_name,r_frame_rate -show_entries format=duration -of json "$work/branded.mp4" \
  > "$out/takeone-brand-take-probe.json"
grep -q '"codec_name": "h264"' "$out/takeone-brand-take-probe.json"
cp "$work/branded.mp4" "$out/takeone-brand-take-after.mp4"
printf '%s\n' "{\"target\":{\"version\":\"$(node -p 'require("./package.json").version')\"},\"commit\":\"$(git rev-parse HEAD)\",\"start\":\"a clean checkout and the staged Tidewater board, no take captured or rendered yet\",\"steps\":[\"capture the headless board scene at 2x with one title and one caption\",\"plan and render it offline with takeone make --no-ai, then decode a still at $at s\",\"render the same take again with --brand, a brand file carrying the Tidewater palette and a display typeface as a font file, and decode the same still\",\"read the 1x1 stage pixel at 6,6 in both stills\",\"render the take with a brand file naming a typeface TakeOne neither bundles nor carries, and record its exit status and message\",\"probe the branded film\"],\"result\":\"the same take twice: the still without --brand, and the still with it in the brand's deep-water stage, teal accent, serif title and the band's caption in Manrope, with the unbundled typeface refused by name instead of silently rendering another face\"}" > "$out/steps.json"
