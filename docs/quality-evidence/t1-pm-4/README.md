# t1-pm-4 candidate output evidence

These artifacts were regenerated from renderer HEAD
`87d47178573488510efcff493c583f01e7b3b29c`, based on main
`684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`. The Tidewater result is a real
scored headless board take from the recovered `screen.webm` source. Acme is a
separate synthetic camera fixture, not a substitute for the Tidewater render.

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
- [Current-candidate provenance and hashes](candidate-output-report.txt)

The Tidewater strip was inspected at full resolution. The dragged card remains
visible while crossing the board and after release. Its recorded drag spans
16.65–18.583333 s; all 117 drag frames keep both the card footprint and cursor
inside the candidate camera crop. The current-main comparison has zero acted-on
region regressions across all ten beats.

The Acme sheet shows the retention slider from before its dialog opens through
the drag and drop. The separate rendered-crop check uses the candidate camera
frames after `stageFrames`, maps each output frame back through the output time
warp, and checks both the cursor footprint and thumb footprint on every frame
from 16 through 30 s. All 841 frames pass.

## Reproduce

Run heavyweight commands one at a time under the shared lock. Dependencies are
already specified in `package-lock.json`.

Tidewater raw input is at
`/home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/real/screen.webm`. The
remaining input plan is committed in `tidewater-plan/`:

```sh
mkdir -p tmp/t1-pm-4-real/analysis
cp /home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/real/screen.webm tmp/t1-pm-4-real/
cp docs/quality-evidence/t1-pm-4/tidewater-plan/{events.jsonl,frames.tsv,take.json} tmp/t1-pm-4-real/
cp docs/quality-evidence/t1-pm-4/tidewater-plan/analysis/* tmp/t1-pm-4-real/analysis/
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node --input-type=module -e 'import { renderTake } from "./src/render/render.ts"; import { DEFAULTS } from "./src/camera/defaults.ts"; await renderTake("tmp/t1-pm-4-real", DEFAULTS);'
```

Regenerate Acme and its current-candidate output with:

```sh
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node scripts/synth-take.ts tmp/t1-pm-4-acme
flock /home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock node --input-type=module -e 'import { makeTake } from "./src/make.ts"; import { DEFAULTS } from "./src/camera/defaults.ts"; await makeTake("tmp/t1-pm-4-acme", { noJev: true, camera: { ...DEFAULTS, fps: 60, caption_font: "Liberation Sans" } });'
node docs/quality-evidence/t1-pm-4/check-acme-detail-visibility.ts
```

The committed output-clock beat files and before/after camera paths can be
checked through the project's executable checker:

```sh
node scripts/check-framing.ts docs/quality-evidence/t1-pm-4/tidewater-output-clock-beats.json 0 docs/quality-evidence/t1-pm-4/tidewater-main-before-camera.json docs/quality-evidence/t1-pm-4/tidewater-candidate-camera.json
node scripts/check-framing.ts docs/quality-evidence/t1-pm-4/acme-output-clock-beats.json 0 docs/quality-evidence/t1-pm-4/acme-main-before-camera.json docs/quality-evidence/t1-pm-4/acme-candidate-camera.json
```

`candidate-output-report.txt` records the raw source and plan hashes, exact
renderer HEAD, camera and rendered-output hashes, and output stream metadata.
`SHA256SUMS` covers every committed artifact in this package. The earlier
`beat-results.txt`, `output-report.txt`, `acme-after.mp4`,
`acme-after-half-sheet.png`, `tidewater-real-after.mp4`, and
`tidewater-real-strip.png` are preserved copies of the superseded evidence;
current-candidate conclusions use the `candidate-*` files and camera paths
listed above.
