# Prove smooth, unbanded footage on every source and export shape

Part of the takeone verification map. Source: `scripts/verification/smooth-matrix.ts` (the matrix), `scripts/quality.ts` (`measureRender`, the absolute bars), `docs/quality.md` (Source and aspect matrix).

## How to get to it (user POV)

A user captures or records a take and exports it at landscape, portrait, square or 4:5 (`takeone render <take> --aspect ...`). The film must hold 60 fps, bt709, no banding, no pan bounce, bounded pan acceleration and sub-pixel judder, at every shape, not just the default one.

## Driving it

Harness: Shell, ffmpeg/ffprobe, tesseract, the pinned headless shell (`node scripts/install-headless-shell.mjs`). Every cell runs through `fm-mem-gate.sh` and `render-slot.sh`, one at a time.

1. `node scripts/verification/smooth-matrix.ts <work-dir> scene-landscape:square synth:4:5 ...` (sources `scene-landscape|scene-portrait|scene-square|synth|phone`, exports `landscape|portrait|square|4:5`).
2. Read each `<work-dir>/<source>-<aspect>/matrix-row.json`: `metrics`, `unmet` (every bar missed, with value and goal), `judder` (null = not measured) and `renderWallSeconds`.
3. Look at the worst frames before believing a number: for a pan spike, `ffmpeg -i out/<id>.mp4 -vf "select='between(n,A,B)',tile=4x1"` around the camera frame with the largest second difference.
4. Same-shape cells have no camera motion, so they pass trivially; judge smoothness on the cross-shape cells.

The drive changes no repo file.
