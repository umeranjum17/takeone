# Output quality gates

`npm run quality` builds the two existing synthetic takes, plans them locally
(`noJev: true`), renders at 60 fps, and rerenders to test byte determinism.
It uses no desktop, device, credentials or model service. Dependencies are the
existing ffmpeg/ffprobe tools plus tesseract (English) and Liberation fonts.
Harness captions explicitly use Liberation Sans to avoid machine-specific
production-font fallback; the production font default is unchanged.
The portrait fixture currently uses the existing test pattern, with demo title
and caption metadata added by the harness; a real portrait UI belongs to the
later demo-asset lane. Nothing here changes production rendering or planning.

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
- Upscale: maximum output width / stage viewport width, hard goal 1.5.
  These fixtures are not hero assets (hero goal 1.0).
- Zoom speed/acceleration: first and second differences of ln(viewport width),
  converted to ln/s and ln/s²; goals 1 and 4.
- Opposite zooms: shortest contiguous hold between opposite signed zoom
  velocities, goal `min_shot`. Speeds ≤0.005 ln/s count as rest, to ignore
  numerical spring tails. No reversals returns `min_shot`.
- Pan acceleration: vector second difference of the projected source origin
  (`-x*out_w/w`, `-y*out_h/h`), goal 9,000 output px/s². Pan bounce counts
  sign reversals without a `min_shot` hold; speeds ≤1 px/s count as rest.
- Subpixel judder: edge centroid on the decoded card's straight left edge,
  measured near the predicted projection at mid-height. RMS second differences
  of measured-minus-ideal positions, goal 0.15 px/frame². Fade and rest frames,
  offscreen edges and low-contrast samples are excluded. Sample count is
  reported; zero moving visible samples is an error, never a passing zero.
- Caption OCR: midpoint of every active interval between caption boundaries
  (including overlaps), excluding intervals shorter than 0.5 s for fades.
  Tesseract reads the decoded pill bounds from the emitted `captions.ass`
  geometry (the union when pills overlap), excluding unrelated UI text. Compare case-sensitive text after
  whitespace normalization, exactly against the expected take captions mapped
  through the output time warp. OCR mismatches and times remain in the JSON. Each input caption also has
  its own mismatch metric, so fixing one cannot conceal breaking another.
- Banding: longest equal-luma run across a decoded rest-frame background row,
  10 pixels from the top at ≥0.7 s, goal ≤64 px.
- Regression: ffmpeg SSIM for every aligned frame versus committed golden
  renders; frames below 0.95 are recorded for human review but do not fail CI
  by themselves. VMAF mean must be ≥95 when ffmpeg provides libvmaf. Stock CI
  ffmpeg may lack libvmaf;
  that run explicitly reports **SSIM only** rather than claiming a VMAF pass.
  Candidate and golden frame counts must match; changed duration requires review.
- Motion blur ghosting: explicitly not applicable; timed region blur is a
  separate rendering feature and does not create motion trails. No fabricated
  value is recorded for an unmeasured effect.

Camera measurements use `stageFrames` so they include the rendered stage clamp,
not only the solver's unclamped path. `default_fps_error` additionally exposes
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
review only; it cannot bypass any numeric regression. Never use it in CI.
Golden videos are synthetic, silent and small enough to store directly in git.
SSIM compares timestamps from zero; changed timelines therefore need visual
review rather than a misleading average-only score.

`--reuse` reuses an already generated/planned fixture to speed up local
measurement debugging, still rerendering and checking determinism. Normal CI
always regenerates both fixtures. When renderer changes are being evaluated,
use the normal command so the first encode and deterministic rerender come
from the same candidate.
