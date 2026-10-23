# Blur the camera moves

Part of the takeone verification map. Source: `src/render/motion-blur.ts`, `src/render/frame-average.ts`, `src/render/camera-filter.ts`, `scripts/motion-blur-proof.ts`. Measurements and method: `docs/motion-blur.md`.

## How to get to it (user POV)

Every full render blurs fast camera moves with a half-frame shutter by default (`motion_blur=1`; a `--preview` never blurs); `--set motion_blur=0` turns it off and values between shorten the shutter. Held framings stay sharp and captions are drawn after the blur.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Use a real take with pans and push-ins (the board take from [Plan and render a recorded take](plan-and-render-a-recorded-take.md), copied twice). A 1920x1080 synthetic take never pushes in at the default `max_upscale`, so it blurs nothing and proves nothing.

1. `node bin/takeone.mjs render <copy-a> --set motion_blur=0` and `node bin/takeone.mjs render <copy-b>` (default 1), one at a time.
2. Read `motion-blur.json` in the take folder of each render: the blurred one has `blurredFrames` above 0 (218 of 2371 on the board take) and `maxSpacingPx` at or under 2, with `tiers` counting frames per sample count; the `motion_blur=0` one has `blurredFrames: 0`.
3. Look at whole frames mid-pan and mid-push-in from both films at the same timestamps: the blurred film shows a short, even streak along the move with no double image of the UI; held frames are identical in both.
4. Capture: the side-by-side mid-move pair to $DONE_DONE_EVIDENCE_ROOT/takeone-motion-blur-after.png and `motion-blur.json` to $DONE_DONE_EVIDENCE_ROOT/takeone-motion-blur-after.json.

The drive changes no repo file: note findings in the run's report.
