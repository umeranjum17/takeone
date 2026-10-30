# Prove a plan edit follows its beat across a re-cut

Part of the takeone verification map. Source: `src/beats/key.ts` (assignBeatKeys), `src/decide/plan.ts`
(readPlan, writePlan, validatePlan), `src/make.ts` (writePlan call, dropped/moved log lines),
`src/render/render.ts` (validatePlan, applyPlan).

## How to get to it (user POV)

`takeone make <id>` writes `analysis/plan.json`. Open it, set a `value` and its `by` to `user` on any beat,
trim the take in `take.json` (`"trim": {"start": <ms>, "end": <ms>}`), and run `takeone make <id>` again. The
edit is still applied to the beat it was made on, even though that beat is now a different `b` number.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. A synthetic clip is never the
proof: use real recorded takes (the staged Tidewater board from `scripts/headless-scene.mjs`, planner output
kept, so no model call). Runs take about 10 minutes each at the shipped 1920x1080/60.

1. `node scripts/install-headless-shell.mjs` once (writes the pinned shell into the gitignored
   `.cache/headless-shell/`), then `node scripts/headless-scene.mjs <new-take-dir>` for a real take.
2. `TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state" node bin/takeone.mjs make
   <take-copy>` (recorded engine). Note each beat's `id` and `key` from `analysis/plan.json`. Run a second take copy the
   same way and check the two plans are byte-identical: keys come from content, not from the run.
3. Edit two beats by hand in one copy: `shot: {"value":false,"by":"user"}` on a click beat, and
   `follow: {"value":false,"by":"user"}` on a drag beat. Record both keys.
4. Re-cut that take (`trim.start` a few seconds in, `trim.end` at the recording length) and `make` it again.
   The log must print one line for each edit whose beat the cut moved to a new id (an edit whose beat keeps its id prints none):
   `plan: the user's edit for beat b<old> follows its beat to b<new> (key k…) - the cut moved it`
5. Assert in the new `analysis/plan.json`: each edited beat is present under its old key at its new `id` with
   `by: "user"`, `dropped` is empty, and the ids that did not move kept their ids and keys.
6. Measure both films' `camera.json` over the moved beats' windows (the after film starts at the trim, so its
   film time is the video time minus `trim.start`). The user's `shot:false` holds one framing
   (`w` constant) where the rules had a slow push in; the user's `follow:false` cuts the camera travel, with
   the drag visibility framing (a separate rule) staying.
7. Cut a still inside each edited beat from both films (`ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1`, threads
   capped) and put before/after side by side as one contact sheet, labelled with the beat id and the key that
   is the same on both sides. Look at it.
8. Negative checks on a plan copy: an edit whose beat the cut removed must appear under `dropped` and be named
   on the log, never applied to the beat that took its place; swapping two entries' keys must be refused by
   `takeone render` (exit 1) with `the edit was made for a different beat`.

The drive changes no repo file: note findings in the run's report.