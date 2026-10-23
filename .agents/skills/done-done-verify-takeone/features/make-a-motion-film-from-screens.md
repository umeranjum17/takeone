# Make a motion film from screens

Part of the takeone verification map. Source: `src/motion/`, `resources/motion/`, `resources/fonts/`, `resources/demo/`, `src/themes.ts`, `scripts/motion-proof.ts`, `scripts/motion-gates.ts`, `scripts/motion-edge.ts`, `scripts/motion-edge-proof.ts`, `scripts/motion-beat-proof.ts`, `scripts/motion-fragment-proof.ts`. Full recipe and gotchas: `docs/verification/motion-films.md`, `docs/motion.md`.

## How to get to it (user POV)

The user has screenshots, an HTML page or a URL and wants a launch film without recording: `takeone motion design.png --out <dir> --title "Ship your next idea" --device browser`. It writes a take-shaped folder (`take.json`, `sources/`, `storyboard.json`, `out/<id>.mp4`, `render.json`); `takeone render <dir> --aspect portrait` re-lays the same timeline and `--stills 1.5,8.5` writes PNGs. With three or more screens and no `--pattern` the local rules plan a launch film (kinetic type, one beat per labelled screen, a bento recap, the end card). No screenshot is sent to a planner.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Needs the pinned headless shell (`node bin/takeone.mjs motion install-shell` once; `takeone doctor` prints its identity in the `motion-shell` row).

1. `TAKEONE_DIR=<scratch>/takes node bin/takeone.mjs motion resources/demo/tidewater-board.png --out <scratch>/takes/motion --title "Plan the launch with Umer" --device browser --no-ai`. Exit 0; `storyboard.json` records `planner: {by: "local", ...}`; `out/motion.mp4` probes 1920x1080.
2. Every pattern: rerun on the same screen with `--pattern hero-reveal,zoom-tour,end-card,kinetic-type`, and once with three or more screens and no `--pattern` (each with a `--region ...:label`) for the launch film with its per-screen type beats and the bento recap. `clip` and `statement` scenes come only from a storyboard with `clips` (`--storyboard <file.json>`, the shape of `resources/demo/film/storyboard.json`; its clip paths must point at real takes). `--device phone` frames a screen in the phone frame. Image planning by a model is off (`src/motion/ai.ts` holds the vocabulary for when redaction exists), so every run is planned by the local rules.
3. `node bin/takeone.mjs render <scratch>/takes/motion --aspect portrait` writes `out/motion-1080x1920.mp4`; `--stills` writes PNGs at the times asked.
4. Look at the frames: decoded settled holds and mid-move frames show the board whole in its browser frame, the title readable and inside the 5% inset, and no word or control cut by a close-up edge.
5. A change to this path also needs the visual pass's motion cells (`motion-dark`, `motion-light`): `done-done run visual-reference` on the base checkout, then `done-done verify visual` on the candidate.
6. Capture: a still from each shape to $DONE_DONE_EVIDENCE_ROOT/takeone-motion-after.png (side by side) and the ffprobe JSON to $DONE_DONE_EVIDENCE_ROOT/takeone-motion-after.json.

The drive changes no repo file: note findings in the run's report.
