# Prove portrait, square and 4:5 exports re-aim on every act

Part of the takeone verification map. Source: `src/render/render.ts` (which export shapes move), `src/camera/solver.ts` (`baseWidth`, `pressShots`), `scripts/verification/act-framing.ts` (the measurement).

## How to get to it (user POV)

A user records a desktop take and exports it for a phone feed: `takeone render <take> --aspect portrait`
(or `square`, `4:5`). The crop fills the frame and follows the action: it frames each beat's subject
and pans to a far control the planned shot cannot hold (a top-bar button, a side feed being scrolled)
from the approach through the press, then returns. A click that opens a dialog keeps the shot on the dialog.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. A synthetic clip is never the proof:
use the realistic board scene (`scripts/headless-scene.mjs`, docs/headless-scene.md).

1. `npm run build`; `node scripts/headless-scene.mjs <dir>`; delete `<dir>/text-boxes.json` (the scene's
   safe-area acceptance is for its own matching-aspect layouts, and a crop of the 16:9 board crosses it);
   `node bin/takeone.mjs make <dir> --set fps=60` with `TAKEONE_DIR`/`TAKEONE_STATE_DIR` in tmp.
2. Copy the planned take once per shape and render each copy, one at a time:
   `node bin/takeone.mjs render <copy> --set fps=60 --aspect square|portrait|4:5`. Keep a copy rendered
   on main (`render` overwrites `out/<id>.mp4`) for the before numbers.
3. Measure every copy: `node scripts/verification/act-framing.ts <copy> 1080x1080` (1080x1920, 1080x1350).
   Expected on the board take: every typing, scroll and drag sample framed, and 8 of 10 clicks with their
   approaches (7 in square). The two top-bar "new task" presses open the dialog the camera holds when it
   appears; in square the top-right menu press has no framing that keeps every word whole, so the planned
   shot stays. On main square shows 6/10 clicks, 0/38 scroll samples and 0 moving frames.
4. Camera gates on the visible window: project `camera.json` through `sourceViewport` and run
   `cameraMetrics` from `scripts/quality.ts`. Press shots must not add pan bounces or raise pan
   acceleration over main's value for the same shape; state each metric before and after.
5. Look at frames DURING the press moves, not only settled ones: `ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1`
   at each press hold's approach, press and return, and a contact sheet over the whole film
   (`fps=2,scale=...,tile=...`). The control and pointer are whole at the press; no edge runs through a word.
7. Text cuts per frame on the shown window: the `scripts/cut-audit.ts` rest/creeping/sweeping split, judged on
   `sourceViewport` frames at the export's own size (the script itself assumes the default wide export).
   Compare at-rest counts with main's for the same shape; a press hold must add none. The shared guard samples
   a hold at its start, middle and end, so a transient lasting a few frames can still slip through.
6. Record the before/after films side by side as one mp4 for the PR.

The drive changes no repo file: note findings in the run's report.
