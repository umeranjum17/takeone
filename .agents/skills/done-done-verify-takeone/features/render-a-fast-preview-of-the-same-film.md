# Render a fast preview of the same film

Part of the takeone verification map. Source: `src/render/preview.ts`.

## How to get to it (user POV)

A user changes a look (a theme, an aspect, a `--set` knob) and wants to see the result
before paying for the full render: `takeone render <take> --preview`.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node scripts/synth-take.ts tmp/verify-synth-demo, then node bin/takeone.mjs make
   tmp/verify-synth-demo --no-ai, then node bin/takeone.mjs render tmp/verify-synth-demo --preview.
3. Check the proof, not the exit code: `out/<id>-preview.mp4` exists, ffprobe reports
   864x486 at 30 fps for a 1080p export (the short edge is at most 500 px, the aspect exact), and `camera.json` is byte-identical
   to the one the full render wrote: the preview frames the film like the full render.
4. Capture: extract one still from the preview MP4 to
   $DONE_DONE_EVIDENCE_ROOT/render-a-fast-preview-of-the-same-film.png, and save the ffprobe
   output and the camera.json comparison to $DONE_DONE_EVIDENCE_ROOT/render-a-fast-preview-of-the-same-film.txt.
5. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
