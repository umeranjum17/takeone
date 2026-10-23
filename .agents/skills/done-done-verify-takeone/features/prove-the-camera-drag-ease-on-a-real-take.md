# Prove the camera drag ease on a real take

Part of the takeone verification map. Source: `src/camera/gesture.ts` (`applyDragVisibility`), `src/camera/solver.ts` (follow), `src/camera/sweep.ts` (`sweepCuts`, the moving-frame text guard), `scripts/quality.ts` (`cameraMetrics`), `scripts/cut-audit.ts` (all-frame cut audit).

## How to get to it (user POV)

Render a take that contains a drag with `node bin/takeone.mjs render <take-dir> --theme midnight`. The camera eases wide for the drag only, then returns to the editorial framing.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. A synthetic clip is never the proof: use real recorded takes (a copy of each take dir, planner output kept, so no model call).

1. `npm run build`, then render the take copy and read the written `<take-dir>/camera.json`.
2. Run `cameraMetrics(frames, 60, 1920, 1080, 1.2)` on the camera projected through the fixed 1600x900 card at (160,54) in 1920x1080: zoom speed <= 1 ln/s, zoom accel <= 4 ln/s², opposite-zoom hold >= 1.2 s, pan accel <= 9000 px/s², pan bounce = 0, max upscale <= 1. All six must pass with no bar relaxed.
3. Audit text cuts on every frame with `node scripts/cut-audit.ts <rendered-take-dir>...` (through the gate; about five minutes a take; needs `take.json`, `analysis/beats.json`, `screen.webm`, `camera.json`). It prints per take the total frames, the cut frames and the split: at rest (the repo's still test), moving under `SWEEP_EDGE_SPEED` (120 output px/s, the crawl a cut must not happen in) and moving at or over it (the allowed sweep), with the run times and the end it bound (take.json's `trim_end`, else the render's own end; it fails if that end does not reproduce `camera.json`'s clock or a frame will not decode, so 0 cuts from 0 decoded frames cannot pass). At rest and moving under 120 px/s must both be 0 on every take. Always state the counts per take with the total frames and that split, never one pooled number.
4. Extract whole PNG frames at the transition moments (ease into the drag, the drag, the release, the follow) with `ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1` and look at each one; sample during transitions, not only settled frames.
5. Put before (main) and after side by side as one mp4, plus a contact sheet of frames sampled during the retimed moves (the guard's moves are the ones whose timing differs from main's `camera.json`).
6. Recheck the bars in step 2 on the after path: the guard only speeds moves up, so watch pan acceleration and bounce in particular.

The drive changes no repo file: note findings in the run's report.
