# Render a synthetic take to a framed demo MP4 offline

Part of the takeone verification map. Source: `scripts/synth-take.ts`.

## How to get to it (user POV)

Run the README quick start from a git checkout: install dependencies, then generate the demo take.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature.

1. Launch the app as SKILL.md says and wait until it is ready.
2. `node scripts/synth-take.ts tmp/verify-synth-demo`, then `node scripts/test-planner.mjs make tmp/verify-synth-demo` for an offline recorded-response test. For a real user run, use `node bin/takeone.mjs make tmp/verify-synth-demo` with a signed-in engine.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/render-a-synthetic-take-to-a-framed-demo.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
