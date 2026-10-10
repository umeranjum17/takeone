# Drawn vector cursor on a cursor-free take

When a take's frames carry no system cursor (`take.json` `cursor_free: true`), the
renderer draws its own cursor from the recorded pointer track (`events.jsonl`
`k:"ptr"`) instead of leaving the pointer invisible. The track is smoothed on the
output clock, projected through the take's camera, and drawn as a vector arrow at
output resolution *after* the camera transform, so it glides without tremor and
stays crisp however far the camera zooms. The pointer hides after ~2 s of stillness
and returns on the next move. Takes without `cursor_free` render exactly as before
(their baked cursor is untouched).

This exists because a captured cursor is a low-resolution, jittery, baked-in
artifact. A cursor-free capture plus this overlay is the "deliberate cursor" path
from the output-review scorecard (J4 P1).

## Sub-features

- Smoothing: a symmetric moving average over the output clock removes input jitter
  without adding lag.
- Camera-locked scale: the cursor scales with the camera zoom (content-locked), so
  its tip stays on the UI it points at and it is redrawn at output resolution at
  every zoom level.
- Idle hide: no pointer movement for ~1.8 s starts a short fade; the cursor is gone
  by ~2.3 s and returns on the next movement.

## How to reach it (user POV)

A cursor-free capture (via `@desklink/host`'s hidden-cursor mode, or the offline
fixture's `--cursor=hidden`) is planned and rendered like any other take; the drawn
cursor appears automatically because the take says `cursor_free`.

## Driving it with the takeone CLI

The offline proof uses the deterministic board fixture with its painted cursor off:

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes"
node scripts/headless-scene.mjs "$TAKEONE_DIR/cursor-free" --cursor=hidden   # writes cursor_free: true, no painted cursor
node bin/takeone.mjs make "$TAKEONE_DIR/cursor-free" --no-jev --set fps=60
node bin/takeone.mjs render "$TAKEONE_DIR/cursor-free" --set motion_blur=0
```

The render writes `cursor.ass` (the drawn cursor) next to `camera.json`.

Proving end state: `out/<id>.mp4` exists; `cursor.ass` has one Dialogue per visible
output frame; `take.json` has `cursor_free: true`. Extract stills and check:

- A wide-shot frame: the cursor measures >= 24 px tall at 1080p.
- A close-up at deep camera zoom: clean anti-aliased edges, no pixel blockiness
  (force a zoom with `--set max_upscale=1.5` and a tight decision if the automatic
  path stays wide).
- Frames ~2.0 s and ~2.5 s into an idle hold: the cursor fades out then is gone, and
  returns on the next move.
- A take without `cursor_free` (e.g. a copy of `data/takes/headless-run-a`): no
  `cursor.ass` is written and the baked cursor is the only cursor.

## Gotchas

- The cursor only appears when `cursor_free: true` is present; a take with a baked
  cursor must never get a second drawn cursor.
- At rest (wide shot) the arrow is ~26 px tall at 1080p; the raw art's ink box is
  24.5 px (the 24×32 viewBox includes padding), so measure the rendered pixels, not
  the viewBox.
- The camera can stay wide on `--no-jev` heuristics; exercise the zoom extreme by
  raising `max_upscale` and forcing a tight decision on a small zone.
- The pointer track is on the event clock; the render maps it through `offset_ms`
  and the trim/squeeze timeline, so a wrong `offset_ms` offsets the cursor.
