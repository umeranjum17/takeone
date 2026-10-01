# t1-pm-4 current-candidate output evidence

The real Tidewater take and Acme fixture were rendered from reviewed candidate
`8f8cf08903046cf9fb258dc4eb84dfb70b3fb27e`, git tree
`b4daccbb8e8a609ac7a6b733728de99eedf8c4d2`, based on main
`684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`. The output-source digest and
render configurations are recorded in [candidate-output-report.txt](candidate-output-report.txt)
so later evidence-only commits can be compared without claiming they rendered
themselves.

## Candidate output

- [Tidewater candidate MP4](tidewater-candidate-after.mp4)
- [Tidewater drag strip](tidewater-candidate-strip.png), sampled 15.5–19 s at
  0.5 s intervals, including lead-in and post-drop frames.
- [Acme candidate after-half sheet](acme-candidate-after-half-sheet.png), 1 fps
  for output times 16–32 s.
- [Acme candidate MP4](acme-candidate-after.mp4)
- [Acme 16–30 s frame check](acme-detail-visibility.json): 841 frames, zero
  cursor misses, zero retention-thumb misses.
- [Per-beat before/after results](candidate-beat-results.txt)
- [Rendered source provenance and hashes](candidate-output-report.txt)

The Tidewater strip was visually inspected at full resolution. The dragged
card remains visible while crossing the board, at release, and after drop. Its
recorded drag spans 16.65–18.583333 s; all 117 drag frames keep both the card
footprint and cursor inside the candidate camera crop. The current-main
comparison has zero acted-on region regressions across all ten beats.

The Acme sheet shows the retention slider from before its dialog opens through
the drag and drop. The rendered-crop check uses the candidate camera frames
after `stageFrames`, maps each output frame back through the output time warp,
and checks both cursor and thumb footprints on every frame from 16 through 30
s. All 841 frames pass.

The former renderer-`87d4717` outputs and their report are preserved under
[previous-87d-render](previous-87d-render/); current-candidate conclusions use
the files linked above.

## Reproduce

Run every media render under the shared lock. Dependencies are specified in
`package-lock.json`.

Tidewater raw input is at
`/home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/real/screen.webm`. Its
matching plan is committed in `tidewater-plan/`:

```sh
mkdir -p tmp/t1-pm-4-reviewed-real/analysis
cp /home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/real/screen.webm tmp/t1-pm-4-reviewed-real/
cp docs/quality-evidence/t1-pm-4/tidewater-plan/{events.jsonl,frames.tsv,take.json} tmp/t1-pm-4-reviewed-real/
cp docs/quality-evidence/t1-pm-4/tidewater-plan/analysis/* tmp/t1-pm-4-reviewed-real/analysis/
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node --input-type=module -e 'import { renderTake } from "./src/render/render.ts"; import { DEFAULTS } from "./src/camera/defaults.ts"; await renderTake("tmp/t1-pm-4-reviewed-real", DEFAULTS);'
cp tmp/t1-pm-4-reviewed-real/out/headless-demo.mp4 docs/quality-evidence/t1-pm-4/tidewater-candidate-after.mp4
cp tmp/t1-pm-4-reviewed-real/camera.json docs/quality-evidence/t1-pm-4/tidewater-candidate-camera.json
```

Generate and render the Acme fixture with this candidate:

```sh
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node scripts/synth-take.ts tmp/t1-pm-4-reviewed-acme
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node --input-type=module -e 'import { makeTake } from "./src/make.ts"; import { DEFAULTS } from "./src/camera/defaults.ts"; await makeTake("tmp/t1-pm-4-reviewed-acme", { noJev: true, camera: { ...DEFAULTS, fps: 60, caption_font: "Liberation Sans" } });'
cp tmp/t1-pm-4-reviewed-acme/out/synth-demo.mp4 docs/quality-evidence/t1-pm-4/acme-candidate-after.mp4
cp tmp/t1-pm-4-reviewed-acme/camera.json docs/quality-evidence/t1-pm-4/acme-candidate-camera.json
node docs/quality-evidence/t1-pm-4/check-acme-detail-visibility.ts tmp/t1-pm-4-reviewed-acme
```

Create the contact sheet and drag strip from those rendered MP4s:

```sh
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock ffmpeg -nostdin -v error -y -ss 16 -t 17 -i docs/quality-evidence/t1-pm-4/acme-candidate-after.mp4 -vf "select=not(mod(n\,60)),scale=480:270,pad=480:302:0:32:color=0x101116,drawtext=fontfile='resources/fonts/Geist.ttf':text='After %{eif\:16+n\:d} s':fontsize=20:fontcolor=white:x=12:y=6,tile=4x5" -frames:v 1 docs/quality-evidence/t1-pm-4/acme-candidate-after-half-sheet.png
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock ffmpeg -nostdin -v error -y -ss 15.5 -t 4 -i docs/quality-evidence/t1-pm-4/tidewater-candidate-after.mp4 -vf "select=not(mod(n\,30)),scale=640:360,pad=640:398:0:38:color=0x101116,drawtext=fontfile='resources/fonts/Geist.ttf':text='Tidewater %{expr\:15.5+n/2} s':fontsize=24:fontcolor=white:x=12:y=7,tile=4x2" -frames:v 1 docs/quality-evidence/t1-pm-4/tidewater-candidate-strip.png
```

The committed output-clock beat files and before/after camera paths use the
executable framing checker. Pass the trim start in seconds; these two fixtures
start at zero:

```sh
node scripts/check-framing.ts docs/quality-evidence/t1-pm-4/tidewater-output-clock-beats.json 0 docs/quality-evidence/t1-pm-4/tidewater-main-before-camera.json docs/quality-evidence/t1-pm-4/tidewater-candidate-camera.json
node scripts/check-framing.ts docs/quality-evidence/t1-pm-4/acme-output-clock-beats.json 0 docs/quality-evidence/t1-pm-4/acme-main-before-camera.json docs/quality-evidence/t1-pm-4/acme-candidate-camera.json
```

`SHA256SUMS` covers the current evidence package and the preserved previous
render files.
