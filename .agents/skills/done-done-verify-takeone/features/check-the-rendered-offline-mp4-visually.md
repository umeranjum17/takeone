# Check the rendered films visually

Part of the takeone verification map. Source: `scripts/verification/visual-check.ts`, `scripts/verification/visual-pass.sh`, `scripts/verification/visual-controls.sh`, `scripts/verification/visual-design.sh`, `scripts/verification/synth-phone-font.ts`, `scripts/synth-portrait.ts`. Full procedure, including the spend approval: `docs/verification/README.md`, `docs/verification/operations.md`.

## How to get to it (user POV)

Run by hand on a rendered take (or by the visual pass on each cell), the visual check decodes its MP4 and fails on stretched, blank, clipped, off-screen or covered content. The visual pass renders the canonical offline takes in ten cells (16:9, a tall 1080x2400 phone take rendered at 1080x1920, 4:5, the Android largest-font board and a motion film, each dark and light) and checks every one.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` (set `TAKEONE_GATE` to it for the visual pass).

1. One film: `node scripts/verification/visual-check.ts <take-dir> --name <cell> --out <dir>`, then `ffmpeg -ss 5` to extract one still from `out/<id>.mp4`. Exit 0 is a pass, 1 names each defect with its time.
2. All ten cells: `done-done run visual-reference` on the base checkout (no model calls) and keep its run folder; then `TAKEONE_VISUAL_REF=<that folder> done-done verify visual --outcome "..."` on the candidate. `visual` and `visual-design` spend judge calls, so they wait at their gate until the user approves that run; `done-done run` refuses them.
3. The checks must still catch defects: `TAKEONE_VISUAL_REF=<ref> TAKEONE_VISUAL_WORK=<ref>/work done-done run visual-controls` corrupts the good films and every control must fail with its named defect.
4. Capture: the `<cell>-t<time>-side.png` sheets and `index.md` the pass writes go to the run folder; look at each sheet.

The drive changes no tracked repo file (the pass's `npm run build` writes only the gitignored `dist/`): note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
