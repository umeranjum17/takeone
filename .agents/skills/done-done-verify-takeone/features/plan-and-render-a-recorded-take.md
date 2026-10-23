# Plan and render a recorded take

Part of the takeone verification map. Source: `bin/takeone.ts`, `src/make.ts`, `src/perceive/`, `src/beats/`, `src/decide/heuristics.ts`, `src/decide/mapping.ts`, `src/camera/`, `src/render/render.ts`, `src/render/stage.ts`, `src/render/camera-filter.ts`, `src/render/pace.ts`, `src/render/ffmpeg.ts`, `src/render/safe-area.ts`, `src/types.ts`, `scripts/headless-scene.mjs`, `scripts/headless/`, `scripts/test-headless-scene.mjs`, `scripts/check-framing.ts`. Full recipe and gotchas: `docs/verification/plan-and-render-take.md`.

## How to get to it (user POV)

After recording a take, the user runs `takeone make <id>`: it decodes the screen, finds the changed regions and actions, cuts beats, decides each beat's shot, solves the camera and renders `out/<id>.mp4` with the plan beside it in `analysis/`. This is the path every film goes through; `--no-ai` keeps every decision local.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture, render and ffmpeg. A synthetic clip is never the proof: use the realistic board scene, a real recorded take.

1. `node scripts/install-headless-shell.mjs` once, then `node scripts/headless-scene.mjs <scratch>/board` (about ten minutes; a fictional Tidewater board, 3840x2160, typing, clicks, a dialog, a scroll and a drag).
2. `TAKEONE_DIR=<scratch>/takes TAKEONE_STATE_DIR=<scratch>/state node bin/takeone.mjs make <scratch>/board --no-ai`. Exit 0; `analysis/beats.json`, `analysis/plan.json` (one entry per beat, each with `id` and `key`) and `analysis/decisions.jsonl` (one line per decided beat) exist; `out/board.mp4` probes 1920x1080 H.264.
3. Look at the film, not the exit code: `node scripts/verification/visual-check.ts <scratch>/board --name board --out <scratch>/check` must report no clipped text or blank frames, and whole PNG frames decoded during the dialog arrival, the drag and the pull-back (`ffmpeg -ss <t> -i out/board.mp4 -frames:v 1`) show the action whole and in frame.
4. `done-done run core` drives the same path on the synthetic take and is the minimum for any change here. A change to this path also needs the visual pass across shapes and themes: `done-done run visual-reference` on the base checkout, then `TAKEONE_VISUAL_REF=<that run's folder> done-done verify visual --outcome "..."` on the candidate (it spends judge calls, so it waits at its gate for approval). The 10 cells cover 16:9, 9:16, 4:5, the Android large-font board and motion, each dark and light.
5. Capture: one still at the dialog to $DONE_DONE_EVIDENCE_ROOT/takeone-make-after.png, the ffprobe JSON to $DONE_DONE_EVIDENCE_ROOT/takeone-make-after.json, and a contact sheet of the film (`fps=1/3,scale=480:-1,tile=4x4`) to $DONE_DONE_EVIDENCE_ROOT/takeone-make-after-sheet.png.
6. Stop what you started; the takes and state stay under the scratch folder.

The drive changes no repo file: note findings in the run's report.
