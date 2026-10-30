---
name: "done-done-verify-takeone"
description: "Drive the takeone Web UI (scripts/e2e/scene.html, the staged Tidewater board opened as a file:// page), plus the offline CLI `takeone make` pipeline that renders an MP4 the way a user does and capture proof it works. Use when proving a takeone change, capturing evidence, or keeping the feature map honest."
---

# done-done-verify-takeone

Written by `done-done init` through claude from this repo's own files (surface: Web UI (scripts/e2e/scene.html, the staged Tidewater board opened as a file:// page), plus the offline CLI `takeone make` pipeline that renders an MP4). The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.

## Launch

node scripts/synth-take.ts "$PWD/tmp/verify-synth-demo" && npm run build && TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state" scripts/verification/recorded-engine.sh "${TAKEONE_DIR:-tmp}/engine" node bin/takeone.mjs make "$PWD/tmp/verify-synth-demo"

Safe: The offline-render journey in .done-done.yaml runs scripts/synth-take.ts and then bin/takeone.mjs make through scripts/verification/recorded-engine.sh, so planning is recorded with no account, key or paid service. TAKEONE_DIR and TAKEONE_STATE_DIR point takes and planner state into the run's own tmp folder, so the owner's state is never touched. The build step runs after the synthetic take is generated, and the journey's own ordering is otherwise kept (from `scripts/synth-take.ts`).

Ready: The make command exits 0 (it prints the plan and beat summary, not the output path); tmp/verify-synth-demo/out/synth-demo.mp4 exists and ffprobe reports a readable video stream. Tear down what you started; never kill by process name.
Isolation: Each run writes only under its own tmp/verify-* directories, with TAKEONE_DIR and TAKEONE_STATE_DIR set so takeone never reads or writes the owner's takes or planner state; the recorded engine keeps planning offline. Use a fresh tmp directory per run and never point these variables at a real account or the owner's own state.
When the repo's .done-done.yaml has an instance block, done-done already runs the app at $DONE_DONE_BASE_URL (its own port and HOME): BASE is then that URL, never a hard-coded port.

## Drive

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature. Drive through the repo's real handles that each feature file names:

- [Render a synthetic take to a framed demo MP4 offline](features/render-a-synthetic-take-to-a-framed-demo.md): Run the README quick start from a git checkout: install dependencies, then generate the demo take (`scripts/synth-take.ts`)
- [Plan and render a recorded take](features/plan-and-render-a-recorded-take.md): `takeone make <id>` (recorded engine) on the realistic board scene: perception, beats, camera and render, judged from whole frames of the film, with push-ins on clicks, scrolls and dense pages (`src/make.ts`, `src/perceive/`, `src/beats/`, `src/camera/`)
- [Score the film and let it improve in rounds](features/score-the-film-and-improve-it-in-rounds.md): run `takeone make --target-score` on a real take, read `out/score.json`, and see the weaker items fixed in a later round (`src/score/`, `src/cli.ts`)
- [Plan a take with the AI planner](features/plan-a-take-with-the-ai-planner.md): `takeone make <id>` with a key, a picked account or a signed-in CLI; the free preflight refusal, and a billed run only with approval (`src/decide/`)
- [Change the look and shape of a film on rerender](features/change-the-look-and-shape-on-rerender.md): `takeone render <take> --theme`, `--set`, `--aspect`, `--resolution`, `--format`, and `take.json` cuts, speed and zooms (`src/themes.ts`, `src/render/edits.ts`)
- [Add keycaps, spotlights and blur to a take](features/add-keycaps-spotlights-and-blur.md): shortcut keycaps from recorded combos, `take.json` spotlight, blur and toast windows (`src/render/overlays.ts`)
- [Blur the camera moves](features/blur-the-camera-moves.md): the default half-frame shutter on fast camera moves, `--set motion_blur` (`src/render/motion-blur.ts`)
- [Render a fast preview of the same film](features/render-a-fast-preview-of-the-same-film.md): `takeone render <take> --preview` renders the same camera path at 30 fps with the short edge at most 500 px (864x486 for 1080p), from a proxy no larger than 1080p; `camera.json` must stay byte-identical to the full render's
- [Prove a plan edit follows its beat across a re-cut](features/prove-a-plan-edit-follows-its-beat-across-a-re-cut.md): Edit `analysis/plan.json` by hand, trim the take, run `make` again, and assert the edit lands on the same beat key at its new id (`src/beats/key.ts`, `src/decide/plan.ts`)
- [Prove the whole approved plan is editable](features/prove-the-whole-plan-is-editable.md): edit per-beat tightness/focus and the film's look in `analysis/plan.json`, render, and see unsupported edits refused with the beat or field named (`src/decide/plan.ts`)
- [Prove the camera drag ease on a real take](features/prove-the-camera-drag-ease-on-a-real-take.md): Render a real take with a drag, then measure the camera bars and the per-frame text cuts, and keep the dragged card and cursor in view through a trim or cut across the drag, wide and portrait (`src/camera/gesture.ts`, `src/render/edits.ts`, `scripts/drag-audit.ts`)
- [Prove portrait, square and 4:5 exports re-aim on every act](features/prove-portrait-square-and-4-5-exports-re-aim-on-every-act.md): Render the board scene take with `--aspect portrait|square|4:5` and measure every act against the shown crop (`scripts/verification/act-framing.ts`)
- [Prove a manual zoom arrives and holds on every export shape](features/prove-a-manual-zoom-arrives-and-holds-on-every-shape.md): Render the board scene at its own portrait and square shape (and as a phone take) with `take.json` zooms and measure arrival, hold and the move gates on the shown window (`scripts/verification/manual-zoom.ts`)
- [Prove a phone take frames each tapped control](features/prove-a-phone-take-frames-each-tapped-control.md): Record the Tidewater fixture on your own Android emulator, render portrait and wide, and check each tap sits inside the shown view with nothing cut
- [Edit a zoom and reuse a saved look without keyframes](features/edit-a-zoom-and-reuse-a-saved-look.md): `takeone zoom <take> list|add|move|remove` edits `take.json` zooms and `takeone look save|list|show|remove` + `render --look` reuse a named theme, aspect and `--set` set; stills from a real board render, before and after (`src/refine.ts`)
- [Size, hide and loop the drawn cursor on a real take](features/size-hide-and-loop-the-drawn-cursor.md): Render a cursor-free take with `cursor_size`, `cursor_hide_idle_s` and `cursor_loop`, then measure size, fades, loop end and click arrival from the encoded film (`scripts/cursor-audit.ts`)
- [Prove titles and captions stay off the app in every export shape on a real take](features/prove-captions-clear-toasts-on-a-real-take.md): Capture the headless board and its portrait layout as a phone take, add a title and captions, render every shape, theme, a long caption and a 320x180 export, and read `covers` in `safe-area.json` (`src/render/stage.ts`, `src/render/render.ts`)
- [Make a motion film from screens](features/make-a-motion-film-from-screens.md): See the feature page for supported recipes, local versus model planning, render behavior and checks (`src/motion/`, `resources/motion/`, `scripts/motion-determinism.ts`)
- [Add click ticks, narration and ducked music](features/add-film-sound.md): `takeone render <take> --set click_sound=1 --set narration=FILE --set music=FILE` muxes one AAC stream, music ducks under the voice (`src/render/sound.ts`)
- [Frame a recording with model-made motion segments](features/frame-a-recording-with-model-made-segments.md): `takeone motion film <video> --intro/--callout/--outro` has the signed-in engine write HTML, Canvas or Three.js segments, renders them offline and cuts them into one film beside the real footage (`src/motion/film.ts`, `src/motion/segment.ts`, `resources/demo/segments/`)
- [Record a take](features/record-a-take.md): `takeone doctor`, `takeone record` (desktop, `--android`, `--ios-sim`), `stop` and `list`, only on dedicated fixtures (`src/record.ts`, `src/android/`, `src/ios/`)
- [Plan a capture with the user's account](features/plan-a-capture-with-the-users-account.md): `takeone capture make <take> --planner-account` plans through the signed-in account `takeone make` resolves, and stops with `planner-unavailable` instead of planning with local rules when there is none
- [Print the installed version](features/print-the-installed-version.md): Run the `version` journey: `takeone --version` and `-v` against package.json, under a node-only PATH
- [Check the rendered films visually](features/check-the-rendered-offline-mp4-visually.md): the visual check on one film, and the `visual-reference`, `visual`, `visual-controls` and `visual-design` journeys across ten shape and theme cells (`scripts/verification/`)
- [Drive the Tidewater board in a browser through the staged scene](features/drive-the-tidewater-board-in-a-browser-t.md): Open scripts/e2e/scene.html directly as a file:// page; it is the staged Tidewater board used by the e2e takes (`scripts/e2e/scene.html`)
- [Prove smooth, unbanded footage on every source and export shape](features/prove-smoothness-on-every-source-and-export-shape.md): Render each source at each export shape and measure the absolute pan, bounce, judder, banding and cost bars on the decoded film (`scripts/verification/smooth-matrix.ts`)
- [Run the output quality gates on real and synthetic takes](features/run-the-output-quality-gates.md): `npm run quality` gates three fixtures, including the real-UI headless scene, with every §4 metric and the all-frame text-cut audit, and prints `passed` only when every goal is met (`scripts/quality.ts`, `scripts/cut-audit.ts`)
- [Install and run the published CLI](features/install-and-run-the-published-cli.md): pack the package, install into an empty npm prefix, and verify both executable names print the package version and `takeone doctor` runs with bundled `dist/` and runtime dependencies.

Static checks (floor guard, typecheck and tests) run in CI (`.github/workflows/ci.yml`) and are not a journey here; the output quality gates run in CI and as the `quality` journey: done-done is the local proof on the real product, and its receipt feeds the merge gate. To find the journey a change needs, run `done-done affected <base>`: it reads the paths each feature cites.

## Evidence

What to capture: Exit codes and terminal transcripts of each step; ffprobe JSON of the MP4 (duration, size, width, height, codec); a decoded still at 5 seconds; sha256sums of the MP4 and still; visual-check output in the evidence folder. Exercise the real user path, not internal setters; done-done's judge checks every capture in the run folder against the outcome, so save only captures of the resulting state there and keep any of earlier steps outside it; verify side effects alongside what is visible. Evidence goes to the run folder `done-done run` prints.

## Cleanup

Stop the instances this run started and remove scratch state. Evidence survives cleanup: never delete the run folder.
