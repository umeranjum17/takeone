# Change the look and shape of a film on rerender

Part of the takeone verification map. Source: `src/themes.ts`, `src/camera/defaults.ts`, `src/render/edits.ts`, `src/render/framing.ts`, `src/render/stage.ts`, `src/render/pace.ts`, `src/render/safe-area.ts`, `src/render/render.ts`, `src/cli.ts`, `scripts/theme-proof.ts`. Full recipes (aspect, format, cuts, speed, held path): `docs/verification/rerender-look-tweaks.md`, `docs/edit-controls.md`, `docs/look.md`.

## How to get to it (user POV)

The user has a planned take and wants another look or shape without planning again: `takeone render <take-dir> --theme paper`, `--set key=value` for any token in `src/camera/defaults.ts`, `--aspect landscape|portrait|square|4:5`, `--resolution 4k`, `--format mp4|gif|webm|prores4444`, plus `cuts`, `speed` and `zooms` saved in `take.json`. Rerendering never calls the planner.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Copy the planned board take from [Plan and render a recorded take](plan-and-render-a-recorded-take.md) first: `render` overwrites `out/<id>.mp4`.

1. `node bin/takeone.mjs render <copy> --theme paper --aspect 4:5`. Exit 0; stdout ends in `out/<id>.mp4`; ffprobe reports 1080x1350.
2. Look at the film: whole frames during camera moves and settled holds show the board in the paper theme, cropped to fill (no letterbox: `cropdetect` reports the full frame), with no word or control cut at a frame edge and the title inside the 5% inset.
3. For other shapes and formats follow `docs/verification/rerender-look-tweaks.md`: per-aspect sizes, the GIF loop marker, bt709 tags on WebM and 4K, and the cuts and typing speed-up checks.
4. A change to this path needs the visual pass: `done-done run visual-reference` on the base checkout, then `TAKEONE_VISUAL_REF=<that run's folder> done-done verify visual --outcome "..."` on the candidate (spends judge calls; waits at its gate for approval).
5. Capture: one still from the rerendered film to $DONE_DONE_EVIDENCE_ROOT/takeone-look-after.png and its ffprobe JSON to $DONE_DONE_EVIDENCE_ROOT/takeone-look-after.json.

The drive changes no repo file: note findings in the run's report.
