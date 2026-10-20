# Run the repo's static checks as a verification journey

Part of the takeone verification map. Source: `scripts/floor-guard.mjs`.

## How to get to it (user POV)

From a checkout, run the checks journey.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node scripts/floor-guard.mjs --base origin/main, then npm run typecheck, then npm test.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/run-the-repo-s-static-checks-as-a-verifi.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
