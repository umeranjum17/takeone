# Prove titles and captions stay off the app in every export shape on a real take

Part of the takeone verification map. Source: `src/render/stage.ts` (`bandLayout`, `narrowScreen`, `bandCamera`, `bandText`, `captionLayouts`), `src/render/render.ts` (every take with text gets the band), `src/render/safe-area.ts` (`covers` in `safe-area.json`), `scripts/headless-scene.mjs` (records the toast's box). Journey test: `test/camera.test.ts` "captions never cover a recorded toast in any export shape".

## How to get to it (user POV)

A take with a `title` or `captions` keeps its card fixed above a reserved text band in every export shape and theme, so text never covers the app or a toast. The card takes the export's shape: a 16:9 board exported portrait, square or 4:5 is cropped to fill it and the camera moves inside it. A screen narrower than the export (a phone take, or a portrait screen in a 16:9 film) shows whole in a card of its own shape, a phone inside its handset. The band takes at most a third of the frame (a tenth of a portrait one), so the card keeps over 55% of a square frame's width and 80% of a portrait one's. Captions shrink to fit one line; a tiny export shrinks the whole band.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture and render. A synthetic clip is never the proof: use the headless board scene.

1. `npm run build`, then capture the board `node scripts/headless-scene.mjs <dir>` (16:9) and its portrait layout `--aspect=portrait`. Mark a copy of the portrait capture as a phone take with `"device": "ios"` in `take.json`.
2. Plan each with `scripts/verification/recorded-engine.sh "${TAKEONE_DIR:-tmp}/engine" node bin/takeone.mjs make <dir>`, then in `take.json` set `trim_end` to `trim_start + 10` and add a title plus captions: one at `trim_start + 0.6` (shown with the title), one long (about 100 characters) at `+ 3.2`, one short at `+ 6.4`.
3. Render copies with `node bin/takeone.mjs render <dir> --set fps=60`: the board with no `--aspect` and with `--aspect portrait`, `square` and `4:5`; the board in portrait with each `--theme` (midnight, paper, aurora, mono, sand, editorial); a tiny export `--set out_w=320 --set out_h=180 --set caption_size=200`; the phone take with `--aspect portrait` and `--aspect landscape`. Every render must exit 0: no text box may cross the 5% safe inset.
4. Read `safe-area.json` `covers` per render: every title and caption must show 0 `frames` (frames its box covers a shown board box, the toast pill included).
5. Cut one whole frame per render in the middle of the title (with the first caption under it) and one in the middle of the long caption, from the timings in `captions.ass`, and look at each: the title and caption sit in their own rows below the card, no text touches the card or the app, the long caption stays whole inside its pill, the phone shows whole in its handset. Enlarge the 320x180 frame with nearest-neighbour scaling to look at it.

The drive changes no repo file: note findings in the run's report.
