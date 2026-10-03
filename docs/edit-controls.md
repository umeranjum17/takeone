# Editing a recording

Add edits to `take.json`, then run `takeone render <take-dir>`. Edits are local,
non-destructive, and cost no planner tokens. `make` also preserves and renders
them. Times below are **seconds relative to the source video**, before trim or
idle pacing. Recorder `trim.start` / `trim.end` still use milliseconds; the
renderer writes `trim_start` / `trim_end` in source-video seconds.

## Output aspect and format

`render` accepts `--aspect landscape|portrait|square`, which selects 1920×1080,
1080×1920, or 1080×1080 output. Without this option, portrait source video
defaults to 1080×1920 portrait output and other sources to 1920×1080 landscape,
unless `--set out_w=...` or `--set out_h=...` supplies custom dimensions.
`--resolution 4k` selects 3840×2160 landscape, 2160×3840 portrait, or
3840×3840 square output. Without `--aspect`, 4K orientation follows the source.
Source orientation uses `take.json`'s `stream.w` / `stream.h` when present,
otherwise its `width` / `height`; this also determines the default output size.
Explicit `--set out_w=...` / `--set out_h=...` dimensions are overridden by
these presets.

`--format mp4|gif|webm|prores4444` selects the output container/encoding and
defaults to `mp4`. GIF output is encoded at 15 fps and scaled to at most 1080
pixels on each axis, preserving aspect ratio without upscaling; WebM uses VP9,
and `prores4444` writes a ProRes 4444 `.mov` file.
These three formats are transcoded from the rendered MP4, which is retained;
ProRes cannot restore detail or chroma discarded by that intermediate.
For example:

```sh
takeone render ~/Videos/takeone/<id> --aspect portrait --format gif
takeone render ~/Videos/takeone/<id> --aspect square --resolution 4k --format webm
```

```json
{
  "cuts": [
    { "t0": 4, "t1": 6 },
    { "t0": 16, "t1": 18 }
  ],
  "speed": [
    { "kind": "type_speed", "rate": 3 },
    { "t0": 8, "t1": 12, "rate": 2 },
    { "t0": 20, "t1": 24, "rate": 1 }
  ],
  "zooms": [
    { "t0": 8, "t1": 14, "bbox": [400, 350, 1200, 90], "level": 3 }
  ]
}
```

- `cuts` removes the listed intervals. `t0` is included; `t1` is excluded.
  Removed click effects, caption starts, and camera beats disappear too.
- A timed `speed` region sets playback rate: `2` doubles it, `0.5` halves it.
  Rates from `0.1` to `16` are accepted. A `rate: 1` region disables automatic
  idle compression there. To apply a rate to the entire video, cover its full
  source interval with one region.
- `kind: "type_speed"` applies to detected typing action bursts, including when
  the enclosing beat is classified as a click. It needs no timestamps. With
  video-only input and no typing events, it has no effect.
- `zooms` frames a source-pixel rectangle `[x, y, width, height]`. The camera
  anticipates the requested arrival at `t0` and holds until `t1`, when automatic
  framing resumes. `level` defaults to `2`: `1` retains more context, `3` uses
  tighter padding, and `0` shows the whole screen. Output aspect and maximum
  pixel upscale still apply.
- Anticipation uses the final padded viewport and respects zoom speed 1 ln/s,
  zoom acceleration 4 ln/s², and pan acceleration 9,000 output px/s². It cannot start
  before the clip or previous cut. When there is insufficient lead, the move
  begins at that boundary and arrives late while retaining the motion limits.
  The CLI reports the lateness; `camera-arrivals.json` retains full-precision
  requested arrival, required lead, boundary, feasible start, actual arrival,
  lateness, hold end, and requested padded framing. A hold may be too short to
  reach the framing; choose a later arrival or longer hold in that case.
- Early edits preserve the opening frame instead of fabricating motion before
  the clip. Landscape recordings in portrait establish wide and then crop the
  active region with the same bounded planner. `camera.json` keeps source-space
  framing plus the exact `padded` viewport used by these bounded moves.

When the native-pixel cap widens a manual request, the CLI reports its requested
and achieved zoom factors. See [render settings](../README.md#render-an-existing-take)
for the default cap and explicit upscale override. `render-camera.json` records
the final output projection and padded source origin. For a fixed card with a
text band, the establishing/rest view includes the configured source padding
inside the card; zoomed views crop into the source without adding nested margins.

Precedence is cuts, timed speed, typing speed, then automatic idle speed.
Within each array, timed intervals may touch but must not overlap; one typing
rule is allowed. Arrays can be empty or omitted. Unsorted intervals work.
Out-of-trim edits are ignored, and partially overlapping intervals are clipped.
A cut that removes all footage is an error. Invalid edits name their field.
Manual zoom intervals must last at least 0.5 source seconds, even outside the
current trim. The rectangle must lie inside the source image.

Footage, camera, and click effects share one source-to-output map. Caption starts
follow that map; their durations remain **output seconds** so speed-up never
reduces reading time. Existing caption overlap rules still clamp a caption at
the next caption's start. A caption whose start was cut disappears; a caption
that started before a cut can finish afterward. A manual zoom entirely removed
by a cut disappears too.

To reproduce the synthetic fixtures and their visual proof:

```sh
node scripts/synth-edits.ts tmp/edit-proof
```

This generates separate takes for cuts, timed speed, typing speed, manual zooms,
and a combined edit. Each has a 1080p60 render, a 4×4 contact sheet, aligned
raw-vs-render footage, and 100% crops of captions and zoom arrivals. The combined
before/after video is aligned through the edit map. `manifest.json` records
frame counts, colour tags, maximum upscale, and frames below SSIM 0.95 for
visual review. All input is a fictional UI with demo person Umer.

For the realistic Tidewater board used in the README, run
`node scripts/proof-board-edits.ts tmp/board-edit-proof` (also requires
`chrome-devtools-axi`). It opens an isolated headless profile, stages the New
task workflow, and renders a take made only from those demo DOM screenshots.
It saves a real before/after frame, contact sheets, a ten-second output clip,
and aligned raw/render and before/after comparison videos. This is a staged
fixture with exact timestamps; it does not record a desktop.

For bounded camera and framing proof from that saved synthetic recording, run:

```sh
node scripts/proof-camera-contract.ts tmp/camera-contract-proof
node scripts/proof-camera-contract.ts tmp/camera-contract-proof --reuse
```

The second command collects metadata and frames from existing outputs without
rendering them again. The script saves portrait and square examples, manual
requests with sufficient lead or a clip/cut boundary, the created card and whole
columns, edited seam samples, exact arrival/hold frames, ffprobe receipts and
source/analysis/camera/edit-clock/video hashes. Every camera budget uses the
final padded viewport. It rejects encoded size, frame-clock or motion-budget
failures; physical screen-corner bounce is recorded separately for review.
Run proof work under the repository's shared heavy-job lock where applicable.

Held automatic portrait and square crops use whole-element boundaries supplied by saved analysis. When a single element cannot fit without cutting neighboring content, the camera widens to include whole neighboring regions. Manual crops retain the requested region. Movement still obeys the final padded viewport budgets.
