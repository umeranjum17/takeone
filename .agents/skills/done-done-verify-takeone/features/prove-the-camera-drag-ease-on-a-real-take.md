# Prove the camera drag ease on a real take

Part of the takeone verification map. Source: `src/camera/gesture.ts` (`applyDragVisibility`), `src/camera/solver.ts` (follow, the crop-to-fill drag carry), `src/render/edits.ts` (`clipDrags`), `src/camera/sweep.ts` (`sweepCuts`, the moving-frame text guard), `scripts/quality.ts` (`cameraMetrics`), `scripts/cut-audit.ts` (all-frame cut audit), `scripts/drag-audit.ts` (drag visibility on every frame).

## How to get to it (user POV)

Render a take that contains a drag with `node bin/takeone.mjs render <take-dir> --theme midnight`. The camera eases wide around the drag (the ease starts one transition before the grab and ends one after the release, each end walked out to a quiet frame), then returns to the editorial framing.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. A synthetic clip is never the proof: use real recorded takes (a copy of each take dir, planner output kept, so no model call).

1. `npm run build`, then render the take copy and read the written `<take-dir>/camera.json`.
2. Run `cameraMetrics(frames, 60, 1920, 1080, 1.2)` on the camera projected through the take's own stage the way `scripts/quality.ts` does (`bandFrames` for a titled take, which on the board take is the 1600x900 card at (160,54) in 1920x1080; `stageFrames` otherwise), with the harness's own bar `d.min_shot`: zoom speed <= 1 ln/s, zoom accel <= 4 ln/s², opposite-zoom hold >= 1.2 s, pan accel <= 9000 px/s², pan bounce = 0, max upscale <= 1. All six must pass with no bar relaxed.
3. Audit text cuts on every frame with `node scripts/cut-audit.ts <rendered-take-dir>...` (through the gate; about five minutes a take; needs `take.json`, `analysis/beats.json`, `screen.webm`, `camera.json`). It prints per take the total frames, the cut frames and the split: at rest (the repo's still test), moving under `SWEEP_EDGE_SPEED` (120 output px/s, the crawl a cut must not happen in) and moving at or over it (the allowed sweep), with the run times and the end it bound (take.json's `trim_end`, else the render's own end; it fails if that end does not reproduce `camera.json`'s clock or a frame will not decode, so 0 cuts from 0 decoded frames cannot pass). At rest and moving under 120 px/s must both be 0 on every take. Always state the counts per take with the total frames and that split, never one pooled number.
4. Extract whole PNG frames at the transition moments (ease into the drag, the drag, the release, the follow) with `ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1` and look at each one; sample during transitions, not only settled frames.
5. Put before (main) and after side by side as one mp4, plus a contact sheet of frames sampled during the retimed moves (the guard's moves are the ones whose timing differs from main's `camera.json`).
6. Recheck the bars in step 2 on the after path: the guard only speeds moves up, so watch pan acceleration and bounce in particular.

### A trim or cut across the drag

A viewer sees the dragged object and the cursor on every frame of the drag the film shows, when the take's `trim_start`, `trim_end` or `cuts` cross the gesture, on a wide export and on a portrait crop of it (the crop is where a lost drag shows: it is about a third of the screen wide).

1. Capture the headless board (`node scripts/headless-scene.mjs <dir>`, through the gate) and `make` it with `--no-ai`. Its one drag runs 16.650-18.583 s.
2. Copy the take once per edit, without `text-boxes.json` (render refuses a portrait crop of a take carrying it on its safe-area gate; a recorded desktop take has none), and set `trim_end` in every copy: trim 12-24; trim starting mid-drag (17.4-24); trim ending mid-drag (12-17.6); cuts over the press (16.4-17.4), inside the drag (17.2-17.9), over the release (18-19.5) and over the create click and the press (13-17.4, with trim 12-24 and with trim 0-24).
3. Render each with `node bin/takeone.mjs render <copy>` and again with `--set out_w=1080 --set out_h=1920` (`--preview` writes the same `camera.json`).
4. Run `node scripts/drag-audit.ts <copy> --boxes <capture>/text-boxes.json [--set out_w=1080 --set out_h=1920]` on each. It reads the drag from `events.jsonl` (never the edited beats, so a dropped drag still counts) and the card from the capture's own text boxes, and must report 0 cursor and 0 card frames out of view, on a nonzero count of frames. Report the counts per copy and shape.
5. Run `scripts/cut-audit.ts` on the wide copies whose `camera.json` changed (it runs the edit clock for `cuts`), and compare `camera.json` with main's: an edit that does not touch the drag must stay byte-identical.
6. Extract a whole frame just after a cut over the press, mid-drag (output 4.433 s for the 16.4-17.4 cut with trim 12-24), from the portrait render on main and on the change, and look at both: the card and the cursor are in the frame after the change.

The drive changes no repo file: note findings in the run's report.
