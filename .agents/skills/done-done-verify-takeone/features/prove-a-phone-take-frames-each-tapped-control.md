# Prove a phone take frames each tapped control in portrait and wide exports

Use when `src/render/render.ts` motion gating, `phoneReframe` or the portrait phone deadzone changes.

1. Record a real take of the Tidewater fixture (`scripts/e2e/android/build.sh`) on your own emulator:
   `takeone record --android <your emulator serial>`; tap New task, Priority, High, Create task. Never use a
   real phone that is attached.
2. Render both shapes through the render gate: `node bin/takeone.mjs render <take> --aspect portrait`, then
   `--aspect landscape`; copy `out/<id>.mp4` and `camera.json` after each render.
3. Measure: `camera.json` has frames off the centred rest framing around each tap; every tap point lies
   inside the shown view at tap time plus 0.4 s.
4. Look at stills at each tap (`ffmpeg -ss <t> -i out/<id>.mp4 -frames:v 1`): the tapped control and its
   dialog are whole, text is not cut at an edge, and the portrait frame is the screen filling the frame,
   not a small handset on a wide margin.

5. A planned film carries a title and captions, so it renders in the text band. Plan the take with the signed-in
   engine (`takeone make <id> --max-tokens 12000`), render both shapes, and require `camera.json` to show
   several framings (`PHONE_BAND_FLOOR`, a view of at least 96% of the screen's width) and stills at and
   between the taps with the logo, dialog and button labels whole.

The drive changes no repo file: note findings in the run's report. The integration test is
`a phone take's portrait and wide exports move to each tapped control` in `test/camera.test.ts`.
