# Output quality gates

`npm run quality` builds the two existing synthetic takes, plans them locally
(`noJev: true`), renders at 60 fps, and rerenders to test byte determinism.
It uses no desktop, device, credentials or model service. Dependencies are the
existing ffmpeg/ffprobe tools plus tesseract (English) and Liberation fonts.
Harness captions explicitly use Liberation Sans to avoid machine-specific
production-font fallback; the production font default is unchanged.
The portrait fixture uses the existing test pattern, with demo title and
caption metadata added by the harness. It does not exercise Android phone
rendering; see the [Tidewater recording evidence](../README.md#3b-record-a-phone-instead-android-hand-driven-on-the-device)
for real-app output. The sharpness fixture additionally exercises the production
camera sampler and encoder on a frozen native 4K Tidewater browser capture.

CI attaches `tmp/quality/metrics.json`, videos, caption crops and similarity logs
to each pull request's workflow run, including failed quality runs. The JSON
records the revision, tool versions, actual stream metadata, all measurements,
OCR expected/actual text, every frame below 0.95 SSIM and failures. Each metric
includes `goalPassed`, evaluated against its absolute §4 target and direction;
this reports goal status but does not change the baseline ratchet gate.

## Measurements

- ffprobe: 60 fps, constant timestamp spacing (2 microseconds of timestamp
  serialization tolerance), exact 1920×1080 or 1080×1920 size, H.264 High,
  yuv420p, bt709 space/transfer/primaries and tv range.
- Frame count: decoded frames versus `camera.json`, absolute difference ≤1.
- Hitches: repeated decoded framemd5 while the stage camera changes by >0.01
  source pixels. Rest frames are excluded.
- Determinism: SHA-256 of two actual MP4 encodes, not just camera JSON.
- Upscale: maximum output width / stage viewport width, goal 1.0.
  See [render settings](../README.md#render-an-existing-take) for the native
  default and explicit upscale override. Lower-resolution whole-screen footage
  cannot gain detail from export resolution.
- Zoom speed/acceleration: first and second differences of ln(viewport width),
  converted to ln/s and ln/s²; goals 1 and 4.
- Opposite zooms: shortest contiguous hold between opposite signed zoom
  velocities, goal `min_shot`. Speeds ≤0.005 ln/s count as rest, to ignore
  numerical spring tails. No reversals returns `min_shot`.
- Pan acceleration: vector second difference of the projected source origin
  (`-x*out_w/w`, `-y*out_h/h`), goal 9,000 output px/s². Pan bounce counts
  sign reversals without a `min_shot` hold; speeds ≤1 px/s count as rest.
- Subpixel judder: edge centroid on the decoded card's straight left edge, or
  the synthetic source's sidebar divider when the text band keeps the card fixed,
  measured near the predicted projection at mid-height. RMS second differences
  of measured-minus-ideal positions, goal 0.15 px/frame². Fade and rest frames,
  offscreen edges and low-contrast samples are excluded. Sample count is
  reported; zero samples on a moving camera is an error. With no camera motion
  at the native cap, the report explicitly marks judder not applicable.
- Caption OCR: midpoint of every active interval between caption boundaries
  (including overlaps), excluding intervals shorter than 0.5 s for fades.
  Tesseract reads the reserved text band when active, otherwise the decoded
  pill bounds from the emitted `captions.ass` geometry (the union when pills
  overlap), excluding unrelated UI text. Compare case-sensitive text after
  whitespace normalization, exactly against the expected take captions mapped
  through the output time warp. OCR mismatches and times remain in the JSON. Each input caption also has
  its own mismatch metric, so fixing one cannot conceal breaking another.
- Zoom sharpness: the native 3840×2160 Tidewater PNG supplies an 800×160
  text reference crop. A 1920×1080 viewport with fractional x/y offsets goes
  through the real camera filter and standard/master encoders. Decode its
  corresponding crop and divide mean squared luma gradient energy by the
  reference energy. Each tier must retain ≥0.75; this absolute check cannot
  be relaxed by baseline ratchets or `--accept-golden`. Source geometry, hash,
  reference/candidate energy, ratios, crops and short encoded clips are recorded.
  See [native-pixel sharpness qualification](sharpness.md) for measurements and
  the regression evidence and capture limitations.
- Flat-card noise: a native uniform 160×30 white patch passes through a
  stage-sized padded surface and the same sampler/encoder at an integer native
  crop. Decoded luma variance must be no more than the native reference variance
  plus 0.05, and mean drift must be ≤4 code values. This
  catches sampler rounding amplified by encoding; blur cannot improve the
  independent text sharpness requirement. See [flat-card qualification](sharpness.md#flat-card-noise-and-motion-qualification)
  for measurements. Noise injection fails this limit in the regression test.
- Banding: longest equal-luma run across a decoded rest-frame background row,
  10 pixels from the top at ≥0.7 s, goal ≤64 px.
- Regression: ffmpeg SSIM for every aligned frame versus committed golden
  renders; frames below 0.95 are recorded for human review but do not fail CI
  by themselves. VMAF mean must be ≥95 when ffmpeg provides libvmaf. Stock CI
  ffmpeg may lack libvmaf;
  that run explicitly reports **SSIM only** rather than claiming a VMAF pass.
  Candidate and golden frame counts must match; changed duration requires review.
- Motion blur ghosting is not part of this harness. The renderer's synthetic
  proof and measurements are documented in [camera motion blur](motion-blur.md).

Camera measurements use `bandFrames` for a fixed card with a text band, otherwise
`stageFrames` to include the rendered stage clamp, rather than only the solver's
unclamped path. `default_fps_error` additionally exposes
whether the production default has reached 60 fps; fixture renders always test
60 fps regardless of that default.

## Baselines and review

`scripts/quality-baseline/metrics.json` stores today's measured failures rather
than pretending all goals already pass. `goalPassed` makes absolute §4 status
visible per metric, while CI continues to gate regressions against these stored
baselines. For a maximum metric the gate is
`value ≤ max(goal, baseline)`; for a minimum metric it is
`value ≥ min(goal, baseline)`. Passing metrics keep their goal. Only 1e-6 relative
round-off is tolerated. A missing, nonfinite or removed measurement fails.

After a quality improvement, run `npm run quality -- --ratchet` and commit the
new JSON to tighten limits. This command must pass the existing numeric gates
and cannot loosen a failing baseline. CI never rewrites baselines. Improvements
must land with their tightened JSON; inspect that diff during review. The
initial baseline was created once with `--init-baseline`, which refuses to
replace an existing file.

Intentional camera, caption or appearance changes can correctly fail the golden
comparison. Review the per-frame SSIM list, OCR crops and rendered videos, then
explicitly run `npm run quality -- --ratchet --accept-golden` to replace golden
videos and tighten numeric baselines together. This switch bypasses similarity
review only; it cannot bypass any numeric regression. Never use it in CI. Golden updates require reviewed before/after output frames;
never accept degraded output to pass the comparison.
Golden videos are synthetic, silent and small enough to store directly in git.
SSIM compares timestamps from zero; changed timelines therefore need visual
review rather than a misleading average-only score.

`--reuse` reuses an already generated/planned fixture to speed up local
measurement debugging, still rerendering and checking determinism. Normal CI
always regenerates both fixtures. When renderer changes are being evaluated,
use the normal command so the first encode and deterministic rerender come
from the same candidate.

Drag framing has a separate visibility check. On two camera paths with the
same output clock, run:

```sh
node scripts/check-framing.ts output-clock-beats.json trim-start-seconds before-camera.json after-camera.json
```

Camera timestamps are relative to the trimmed output, so provide the trim start
in seconds to align them with the beat timestamps. The beat actions use
milliseconds, as consumed by `solveCamera`; when idle pacing is enabled, pass
beats from `warpBeats`. The check compares every frame of every beat and fails
if the after crop loses an acted-on region the before crop contained or a beat
has no frames to compare. It also checks the recorded cursor path and moving
grab footprint throughout each drag, including the release frame. Its table
reports how many before frames contained the region, so an untested region is
visible.

Drag actions preserve the sampled pointer path through planning and pacing.
The camera reserves the object's swept footprint ahead of the drag, rather
than following an earlier dwell. `whole_object` represents explicitly established
complete object bounds at pickup, preserved with the recorded path through
planning and pacing. Changed-pixel regions cannot establish these bounds;
extraction leaves them unknown. Historical inferred `subject` fields are not
trusted. When the whole object is unknown, the camera retains the whole source
and the framing checker fails the drag rather than treating cursor or partial
region coverage as proof of whole-object visibility. The handoff to
the following action retains that context, including when a shot is omitted
by the camera's movement budget.

The t1-pm-4 candidate evidence package is in
[`quality-evidence/t1-pm-4`](quality-evidence/t1-pm-4/README.md). It preserves
historical Acme sheets, main and renderer-bound camera paths, real Tidewater
renders and drag strips, per-beat results, and source/output hashes. Those
results are bound to their recorded renderer commits and do not establish
acceptance for the rebased candidate. The README records the source-digest
mismatch and the five pending actual-output scenarios for the assigned
validation phase. Fresh public-CLI renders and inspection are required before
current-candidate conclusions can be published.
