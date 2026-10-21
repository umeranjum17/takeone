---
name: "done-done-verify-takeone"
description: "Drive the takeone Web UI (scripts/e2e/scene.html, the staged Tidewater board opened as a file:// page), plus the offline CLI `takeone make` pipeline that renders an MP4 the way a user does and capture proof it works. Use when proving a takeone change, capturing evidence, or keeping the feature map honest."
---

# done-done-verify-takeone

Written by `done-done init` through claude from this repo's own files (surface: Web UI (scripts/e2e/scene.html, the staged Tidewater board opened as a file:// page), plus the offline CLI `takeone make` pipeline that renders an MP4). The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.

## Launch

node scripts/synth-take.ts "$PWD/tmp/verify-synth-demo" && npm run build && TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state" node bin/takeone.mjs make "$PWD/tmp/verify-synth-demo" --no-ai

Safe: The offline-render journey in .done-done.yaml runs scripts/synth-take.ts and then bin/takeone.mjs make with --no-ai, so planning is local-only with no account, key or paid service. TAKEONE_DIR and TAKEONE_STATE_DIR point takes and planner state into the run's own tmp folder, so the owner's state is never touched. The build step runs after the synthetic take is generated, and the journey's own ordering is otherwise kept (from `scripts/synth-take.ts`).

Ready: The make command exits 0 and prints the output path; tmp/verify-synth-demo/out/synth-demo.mp4 exists and ffprobe reports a readable video stream. Tear down what you started; never kill by process name.
Isolation: Each run writes only under its own tmp/verify-* directories, with TAKEONE_DIR and TAKEONE_STATE_DIR set so takeone never reads or writes the owner's takes or planner state; --no-ai keeps planning local. Use a fresh tmp directory per run and never point these variables at a real account or the owner's own state.
When the repo's .done-done.yaml has an instance block, done-done already runs the app at $DONE_DONE_BASE_URL (its own port and HOME): BASE is then that URL, never a hard-coded port.

## Drive

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature. Drive through the repo's real handles that each feature file names:

- [Render a synthetic take to a framed demo MP4 offline](features/render-a-synthetic-take-to-a-framed-demo.md): Run the README quick start from a git checkout: install dependencies, then generate the demo take (`scripts/synth-take.ts`)
- [Check the rendered offline MP4 visually](features/check-the-rendered-offline-mp4-visually.md): After make writes the MP4, run the offline-render journey's visual check on the take (`scripts/verification/visual-check.ts`)
- [Drive the Tidewater board in a browser through the staged scene](features/drive-the-tidewater-board-in-a-browser-t.md): Open scripts/e2e/scene.html directly as a file:// page; it is the staged Tidewater board used by the e2e takes (`scripts/e2e/scene.html`)
- [Run the repo's static checks as a verification journey](features/run-the-repo-s-static-checks-as-a-verifi.md): From a checkout, run the checks journey (`scripts/floor-guard.mjs`)
- [Prove the camera drag ease on a real take](features/prove-the-camera-drag-ease-on-a-real-take.md): Render a real take with a drag, then measure the camera bars and the per-frame text cuts (`src/camera/gesture.ts`)

## Evidence

What to capture: Exit codes and terminal transcripts of each step; ffprobe JSON of the MP4 (duration, size, width, height, codec); a decoded still at 5 seconds; sha256sums of the MP4 and still; visual-check output in the evidence folder. Exercise the real user path, not internal setters; done-done's judge checks every capture in the run folder against the outcome, so save only captures of the resulting state there and keep any of earlier steps outside it; verify side effects alongside what is visible. Evidence goes to the run folder `done-done run` prints.

## Cleanup

Stop the instances this run started and remove scratch state. Evidence survives cleanup: never delete the run folder.
