# Prove the camera drag ease on a real take

Part of the takeone verification map. Source: `src/camera/gesture.ts` (`applyDragVisibility`), `src/camera/solver.ts` (follow), `scripts/quality.ts` (`cameraMetrics`).

## How to get to it (user POV)

Render a take that contains a drag with `node bin/takeone.mjs render <take-dir> --theme midnight`. The camera eases wide for the drag only, then returns to the editorial framing.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. A synthetic clip is never the proof: use real recorded takes (a copy of each take dir, planner output kept, so no model call).

1. `npm run build`, then render the take copy and read the written `<take-dir>/camera.json`.
2. Run `cameraMetrics(frames, 60, 1920, 1080, 1.2)` on the camera projected through the fixed 1600x900 card at (160,54) in 1920x1080: zoom speed <= 1 ln/s, zoom accel <= 4 ln/s², opposite-zoom hold >= 1.2 s, pan accel <= 9000 px/s², pan bounce = 0, max upscale <= 1. All six must pass with no bar relaxed.
3. Audit text cuts on every frame (`edgeCuts` via `sourceEdgeCuts`), split into still frames (the at-rest bar) and moving frames. Report both counts.
4. Extract whole PNG frames at the transition moments (ease into the drag, the drag, the release, the follow) with `ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1` and look at each one; sample during transitions, not only settled frames.
5. Put before (main) and after side by side as one mp4.

The drive changes no repo file: note findings in the run's report.
