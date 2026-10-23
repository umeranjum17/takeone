# Run the output quality gates on real and synthetic takes

Part of the takeone verification map. Source: `scripts/quality.ts` (the gates and the baseline ratchet), `scripts/cut-audit.ts` (the all-frame text-cut audit), `scripts/headless-scene.mjs` (the real-UI fixture), `docs/quality.md`.

## How to get to it (user POV)

From a checkout with ffmpeg, tesseract, Liberation fonts and the pinned headless shell (`node scripts/install-headless-shell.mjs`), run `npm run quality`. It builds three fixtures, `synth`, `portrait` and `scene` (the headless capture of the staged board scene, real UI), renders each at 60 fps, and gates every decoded output. The last lines say `quality: passed; every goal met` only when every goal is met; a run that only holds the stored baselines lists each unmet goal instead.

## Driving it

Harness: Shell (bash), `fm-mem-gate.sh` around the whole run (it captures, renders twice per fixture and audits every frame).

1. `npm run quality` from a clean checkout (the `quality` journey in `.done-done.yaml` runs it, keeps the log, metrics and scene MP4 in the run folder, and checks steps 2 to 4 mechanically). Keep its stderr and `tmp/quality/metrics.json`.
2. `jq '.fixtures | keys' tmp/quality/metrics.json` must list `portrait`, `scene` and `synth`: a run without the real-UI `scene` is not a quality result.
3. For each fixture read `metrics.text_cut_at_rest` and `metrics.text_cut_creeping` (goal 0 each) and `cutAudit` (`frames`, the split and the bound `trimEnd`). `cutAudit.frames` must equal `cameraFrames`, and `trimEnd` is the end the render used: the audit throws on an end that does not reproduce `camera.json`'s clock, so a zero from no decoded frames cannot pass.
4. Read the final stderr lines and `goalsUnmet`: every metric with `goalPassed: false` is listed, and the word `passed` appears only when the list is empty.
5. Open whole frames of `tmp/quality/scene/out/headless-demo.mp4` at the first and worst `cutAudit.runs` times with `ffmpeg -ss <t> -i ... -frames:v 1` and look at each one: the counted cut must be visible. Sample during transitions, not only settled frames. Keep those stills outside the run folder: a board frame cannot show the gate's result, so the judge cannot settle the claim from it.

The drive changes no repo file: note findings in the run's report.
