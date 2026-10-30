# Size, hide and loop the drawn cursor on a real take

Part of the takeone verification map. Source: `src/render/cursor.ts` (`cursorAss`), `src/camera/defaults.ts` (`cursor_size`, `cursor_hide_idle_s`, `cursor_loop`), `scripts/cursor-audit.ts`.

## How to get to it (user POV)

Render a cursor-free take with `--set cursor_size=1.5`, `--set cursor_hide_idle_s=0` (never hide) or another number of seconds, and `--set cursor_loop=1`. The drawn arrow changes size, fades after that much stillness (or never), and a looping film ends with the cursor where it began. Every click still lands the tip on its ripple.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture, render and audit. A synthetic clip is never the proof: use the realistic demo scene take.

1. `node scripts/install-headless-shell.mjs`, then `node scripts/headless-scene.mjs <scratch>/scene --cursor=hidden` (about ten minutes) and `TAKEONE_DIR=<scratch>/takes TAKEONE_STATE_DIR=<scratch>/state scripts/verification/recorded-engine.sh "${TAKEONE_DIR:-tmp}/engine" node bin/takeone.mjs make <scratch>/scene --set fps=60`.
2. Copy the planned take twice; in both copies set `take.json` `cursor_free` to false. Render the original and the first copy with `render <take> --set fps=60` plus the cursor settings under test, and the second copy with the same settings plus `--set ripple_ms=0`.
3. `node scripts/cursor-audit.ts <cursor-take> <plain-copy> <no-ripple-copy>` (about a minute). It differences the decoded films' luma, so every number is read from the encoded MP4 (on the demo take at 1080p60, 2370 frames):
   - `repeated_frames` and `unshown_lines` must be 0: every frame shows its own arrow (they were 636 and 635 before the overlay lines were centred on their frames).
   - `arrow_height_px.median` (outline included, camera zoom included) scales with `cursor_size`. At camera zoom 1 the source draws 48 px at size 1 plus about 6 px of outline (about 54 px); the demo take's push-ins raise the measured median to 60 px at 1, 90 at 1.5 and 30 at 0.5.
   - `fades` lists each idle fade: 4 at the default 1.8 s, 8 at `cursor_hide_idle_s=0.8`, none at 0.
   - With `cursor_loop=1`, `loop.last_to_first_px` must be under 1 (43.6 without it).
   - `clicks.max_error_px` must be at most 2 with `clicks.measured` equal to `clicks.presses`; `presses` counts the clicks that draw a ripple (8 of the take's 11; the 3 at the screen's top edge have no room for one).
   - `ink_outside_drawn_frames` stays a handful (encoder drift near scrolling text, not stray ink): open the frames in `ink_outside_at` and confirm one arrow. `ink_missing_at` lists only the film's fade-in and fade-out frames.
4. Extract whole PNG frames during the moves into clicks, an idle fade, and the final loop glide with `ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1`, and look at each one: one arrow, crisp, tip on the ripple, never on the wallpaper.
5. Make a contact sheet of those frames and keep the MP4s as the recording.

The drive changes no repo file: note findings in the run's report.
