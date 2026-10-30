# Prove a manual zoom arrives and holds on every export shape

Part of the takeone verification map. Source: `src/render/render.ts` (manual zooms direct every shape, the late-arrival warning), `src/camera/solver.ts` (`applyManualZooms`), `scripts/verification/manual-zoom.ts` (the measurement).

## How to get to it (user POV)

A user adds `zooms` to a take's `take.json` (`t0`/`t1` source seconds, a source-pixel `bbox`, a 0–3 `level`)
and renders it at any shape: `takeone render <take> --aspect portrait|square|4:5|landscape`. That includes
a take exported at its own shape (a portrait or square capture rendered portrait or square) and a phone
take. The camera starts moving early, on a move long enough to keep within the camera gates, reaches the
box at `t0` and holds it still and whole until `t1`; short of room it speeds up only as far as the gates
allow. When even that cannot make `t0` (too close to the clip start or the previous zoom, or waiting for
its box to paint), or a drag on screen keeps the view wide, the render prints `Manual zoom arrives late: zoom N S s after its requested time, because ...`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture and render. A synthetic clip is
never the proof: use the realistic board scene (`scripts/headless-scene.mjs`, docs/headless-scene.md).

1. `npm run build`; capture the board at the shape you export: `node scripts/headless-scene.mjs <dir> --aspect=portrait`
   (and `--aspect=square`); `scripts/verification/recorded-engine.sh "${TAKEONE_DIR:-tmp}/engine" node bin/takeone.mjs make <dir> --set fps=60` with
   `TAKEONE_DIR`/`TAKEONE_STATE_DIR` in tmp (`make` takes no `--aspect`; the square take's own 16:9 render
   then stops at the safe-area gate, after the plan in `analysis/` is written, which is all step 2 needs). Delete `<dir>/text-boxes.json` from the copy you zoom: a push-in
   crops board text across the 5% inset, which the safe-area gate refuses.
2. Add `zooms` to the copy's `take.json`: one on a quiet stretch (the Activity feed at 25.5-29 s arrives on
   time) and one across the card drag (the In progress lane at 18-23.5 s, which the drag keeps wide and the
   render reports late) and render it at its own shape: `node bin/takeone.mjs render <copy> --set fps=60 --aspect portrait`.
   For a phone take, set `"device": "android"` on a copy of the portrait capture (the handset card and
   rest framing a phone recording gets) and render it the same way.
3. Measure: `node scripts/verification/manual-zoom.ts <copy> 1080x1920` (1080x1080 for square). Expected:
   every zoom `late_s` 0 (or exactly the amount the render printed), `held_s` up to its `t1`, `box_whole`
   true, `depth` above 1, and the move's `zoom_speed` and `zoom_acceleration` within their limits. On main
   a same-shape export prints `camera motion is disabled for this export shape` and the camera never
   leaves rest (depth 1).
4. Look at single frames from the film at each zoom's `requested_s` and mid-hold (`ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1`):
   the box fills the frame, no edge runs through a word, and the frame just before `requested_s` is mid-move, not at rest.

The drive changes no repo file: note findings in the run's report.
