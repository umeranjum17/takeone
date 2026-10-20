# Check the rendered offline MP4 visually

Part of the takeone verification map. Source: `scripts/verification/visual-check.ts`.

## How to get to it (user POV)

After make writes the MP4, run the offline-render journey's visual check on the take.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node scripts/verification/visual-check.ts tmp/verify-synth-demo --name offline-dark --out tmp/verify-evidence, then ffmpeg -ss 5 to extract one still from out/synth-demo.mp4.
3. Capture: screenshot the resulting page to $DONE_DONE_EVIDENCE_ROOT/check-the-rendered-offline-mp4-visually.png, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
