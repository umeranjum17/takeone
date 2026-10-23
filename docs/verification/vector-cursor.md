# Drawn vector cursor on a cursor-free take

When a take's frames carry no system cursor (`take.json` `cursor_free: true`), the
renderer draws its own cursor from the recorded pointer track (`events.jsonl`
`k:"ptr"`) instead of leaving the pointer invisible. The track is smoothed on the
output clock, projected through the take's camera, and drawn as a vector arrow at
output resolution *after* the camera transform, so it glides without tremor and
stays crisp however far the camera zooms. Each click lands the tip on its ripple. The pointer hides after ~2 s of stillness and returns on the next move. Takes without `cursor_free` render exactly as before
(their baked cursor is untouched).

This exists because a captured cursor is a low-resolution, jittery, baked-in
artifact. A cursor-free capture plus this overlay is the "deliberate cursor" path
from the output-review scorecard (J4 P1).

## Sub-features

- Smoothing: a symmetric cosine-weighted window over the output clock eases arrivals
  and departures without adding trailing-filter lag.
- Frame timing: each frame's arrow is an ASS line centred on that frame's time.
  ffmpeg's `ass` filter samples each frame at its truncated millisecond and ASS
  times are centiseconds, so lines on frame boundaries showed the previous
  frame's arrow on every third 60 fps frame and never showed a third of the
  positions.
- Click arrival: around each click ripple (a click's release, a drag's press) the
  smoothed track eases onto the ripple's centre over 0.12 s, so the tip sits on it on
  the frame the ripple starts.
- Size: 48 px arrow height at 1080p times `cursor_size` (default 1, 0.5 to 3), scaled
  by output height and the square root of camera zoom. Its hotspot stays projected onto the recorded UI point; it is redrawn
  at output resolution at every zoom level.
- Screen boundary: a hotspot outside the visible screen hides; remaining arrow ink
  is clipped to the existing rounded screen card, never drawn on the backdrop.
- Idle hide: no pointer movement for `cursor_hide_idle_s` (default 1.8 s) starts a
  0.5 s fade; the cursor returns on the next movement. `cursor_hide_idle_s=0` never
  hides it.
- Loop: `cursor_loop=1` glides the cursor back to its first-frame position over the
  final 0.8 s (starting no earlier than 0.12 s after the last click), so the last
  frame's cursor matches the first.

## How to reach it (user POV)

A cursor-free capture (via `@desklink/host`'s hidden-cursor mode, or the offline
fixture's `--cursor=hidden`) is planned and rendered like any other take; the drawn
cursor appears automatically because the take says `cursor_free`.

## Driving it with the takeone CLI

The offline proof uses the deterministic board fixture with its painted cursor off:

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes"
node scripts/headless-scene.mjs "$TAKEONE_DIR/cursor-free" --cursor=hidden   # writes cursor_free: true, no painted cursor
node bin/takeone.mjs make "$TAKEONE_DIR/cursor-free" --no-ai --set fps=60
node bin/takeone.mjs render "$TAKEONE_DIR/cursor-free" --set motion_blur=0
```

The render writes `cursor.ass` (the drawn cursor) next to `camera.json`.
Inspect decoded motion frames, not just that file: a single large arrow glides
onto the field and fades while idle. Check card-edge motion too: no pointer ink
may spill onto the decorative background. Compare a baked-cursor take: no second arrow
is drawn. Remove the pointer samples from a disposable copy and rerender: it must
warn `No usable pointer samples` and still produce a playable MP4.

### Real desktop capture (`takeone capture record`, X11)

The offline fixture never proves the real capture path; drive it on a throwaway
Xvfb display showing `scripts/e2e/scene.html` (never a personal desktop):

```sh
Xvfb :220 -screen 0 2560x1440x24 -nolisten tcp &            # pick a free high display
node bin/takeone.mjs capture record --source x11::220 \
  --root "$TAKEONE_DIR" --state-dir "$TAKEONE_STATE" --events own --max-seconds 18 &
# drive real page changes (CDP) and sweep the X pointer while it records, then stop
node bin/takeone.mjs make   "$TAKEONE_DIR/<id>" --no-ai --set fps=60 --set max_upscale=1.5
node bin/takeone.mjs render "$TAKEONE_DIR/<id>" --set motion_blur=0
```

On an X11 source the engine always reports `cursor:"hidden"` and never composites
the server cursor into root pixels, so **every** take from X11 is cursor-free
whatever the policy (`TAKEONE_CURSOR=embedded` is a no-op there) and TakeOne always
asks for hidden to turn on the position track. Prove:

- hidden policy (default): `take.json` `cursor_free: true`, `pointer: "mapped"`,
  `events.jsonl` has `k:"ptr"` samples carrying `x,y` (and `hs` where reported), and
  the render shows exactly one cursor — the drawn one — moving with the pointer
  through a camera zoom (force one with `max_upscale`; sample frames during the move,
  not only settled frames).
- `TAKEONE_CURSOR=embedded` on X11: still `cursor_free: true` and one drawn cursor.
- Refusal path (`@desklink/host` refuses hidden only on macOS/Windows/consumer-fed
  sources, which this host cannot produce): point `DESKLINK_ENGINE` at a proxy that
  answers the first `session.open {cursor:"hidden"}` with
  `{"error":{"code":"cursor-unavailable"}}`, while every other message passes through
  to the real engine. Expect one plain message, `cursor_free: false`, and no
  `cursor.ass`. On X11 the retried `embedded` pixels are still cursor-free, so the
  render deliberately shows no cursor; the embedded-paints-a-cursor branch is only
  real on the hardware sources above.

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
- Exactly one cursor per frame: count it in the stills — a baked cursor plus a drawn
  one is the regression this guards.

`node scripts/cursor-audit.ts <cursor-take> <plain-copy> <no-ripple-copy>` reads the
arrow's height, idle fades, loop end, repeated frames and each click's distance from
its ripple out of the encoded film; the copies are the same take rendered with
`cursor_free: false`, the second also with `--set ripple_ms=0`. The verify skill's
[cursor controls entry](../../.agents/skills/done-done-verify-takeone/features/size-hide-and-loop-the-drawn-cursor.md)
lists the expected values.

## Gotchas

- The cursor only appears when `cursor_free: true` is present; a take with a baked
  cursor must never get a second drawn cursor.
- At rest (wide shot) the arrow is ~26 px tall at 1080p; the raw art's ink box is
  24.5 px (the 24×32 viewBox includes padding), so measure the rendered pixels, not
  the viewBox.
- The camera can stay wide on `--no-ai` heuristics; exercise the zoom extreme by
  raising `max_upscale` and forcing a tight decision on a small zone.
- The pointer track is on the event clock; the render maps it through `offset_ms`
  and the trim/squeeze timeline, so a wrong `offset_ms` offsets the cursor.
- An X11 source never bakes the cursor (root GetImage/MIT-SHM has no server sprite),
  so `cursor_free` is true there even under `TAKEONE_CURSOR=embedded`; a real
  refusal (macOS/Windows/consumer-fed) is the only path where embedded pixels carry a
  cursor, and it cannot be produced on a Linux/X11 host — mark it a known limit, do
  not fake it with a painted test cursor.
