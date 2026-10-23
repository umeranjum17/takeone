# Prove captions stay clear of toasts and board text on a real take

Part of the takeone verification map. Source: `scripts/headless-scene.mjs` (writes `toasts` and the toast's box), `src/render/stage.ts` (`bandEligible`, `bandText`, `captionLayouts`), `src/render/safe-area.ts` (`covers` in `safe-area.json`). Journey test: `test/camera.test.ts` "captions never cover a recorded toast".

## How to get to it (user POV)

A take exported at its own shape (16:9, square or portrait; not a phone take) keeps its title and captions in a band below the card, so they never cover the app or a toast. The card keeps over 55% of a square frame's width and 80% of a portrait one's. A render cropped to another shape (a 16:9 board exported portrait) draws captions over the footage; a caption sharing a toast's screen time moves to the top slot for its whole hold, keeping its start and text.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture and render. A synthetic clip is never the proof: use the headless board scene.

1. `npm run build`, then capture `node scripts/headless-scene.mjs <dir> --aspect=portrait`, `--aspect=square` and the default landscape. `take.json` must carry three `toasts` windows of 2.2 s at about 13.6, 30.13 and 37.87 s.
2. Add one caption per action at the take's click times, so three of them share a toast's screen time:
   `node -e 'const f=process.argv[1]+"/take.json",m=require(f);m.captions=[[3.1,"Start a new task"],[6.67,"Add notes for the team"],[11.1,"Set the priority"],[13.5,"Create the task"],[16.65,"Move it to In progress"],[20,"Catch up on the activity feed"],[26.33,"Mark a task done"],[28.63,"Archive finished work"],[34.93,"Start the next task"],[37.77,"Create it in one click"]].map(([t,text])=>({t,d:3,text}));require("fs").writeFileSync(f,JSON.stringify(m,null,2))' <dir>`
3. Run `node bin/takeone.mjs make <dir> --no-ai --set fps=60 --set out_w=1080 --set out_h=<h>`: portrait and the landscape take at 1920 (the landscape one is the cropped overlay path), square at 1080. For a before side, render a copy without its `toasts` key on main. Every render must exit 0: no caption may cross the 5% safe inset.
4. Read `safe-area.json` `covers`: per caption, `frames` (frames its box covers a shown board box, the toast pill included), `labels`, and `clearance` (least output px to any shown box) with `nearest`. Same-shape renders must show 0 frames for every caption; on the cropped render a caption sharing a toast's time must show 0 frames and `nearest` must not be `toast`. Measure the card width from a frame (`cropdetect` or the card edge) against the 55% / 80% floors.
5. Extract whole frames at every caption start and at 10 fps through each toast window (they include the caption's rise and fade, so they sample the transition), and look at each one: no caption pill on or touching a toast, no app label under a caption, no cut text. Open a native-resolution crop of the board to check its text stays readable.

The drive changes no repo file: note findings in the run's report.
