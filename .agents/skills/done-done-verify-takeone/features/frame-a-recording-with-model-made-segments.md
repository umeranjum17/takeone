# Frame a recording with model-made motion segments

Part of the takeone verification map. Source: `src/motion/film.ts`, `src/motion/segment.ts`, `src/motion/hyperframes.ts`, `src/motion/storyboard.ts`, `resources/motion/patterns/segment.js`, `resources/demo/segments/`, `test/motion-segment.test.ts`. Reference: `docs/motion.md` ("Model-made segments").

## How to get to it (user POV)

The user has a rendered demo (`takeone make` output, `out/<id>.mp4`) and wants a title card, a feature callout and a closing card around it: `takeone motion film out/demo.mp4 --intro "…" --callout "…@12" --outro "…" --tech three`. The signed-in AI engine writes each segment as one offline HTML page (DOM, SVG, Canvas or Three.js); TakeOne renders it and cuts it into a film beside the untouched footage. A `.html` path in place of a brief is used as written (no engine needed).

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` + the render slot for every render. Needs the pinned HyperFrames pair and the pinned headless shell (`takeone motion install-hyperframes`, `install-shell`).

1. Make a real footage take: `node scripts/headless-scene.mjs <scratch>/board --aspect=landscape --no-title`, then `node bin/takeone.mjs make <scratch>/board` with a signed-in engine (a real render of the board scene, not a fixture clip).
2. Pages given as files (no engine): `node bin/takeone.mjs motion film <scratch>/board/out/headless-demo.mp4 --intro resources/demo/segments/intro.html --callout resources/demo/segments/callout.html@8 --outro resources/demo/segments/outro.html --out <scratch>/takes/film --workers 2`. Exit 0; `storyboard.json` has `segments` (each with `video` and `made`), scenes `segment, clip(fill), segment, clip(fill), segment`; `out/headless-demo.mp4` probes at the footage's size; `out/scenes.json` lists the five scenes and their frames add up to the film's.
3. Model-written pages: the same command with briefs in place of paths, on the normal HOME with the user's signed-in CLI (never copy its login). Stderr names the planner and each segment it wrote; with a clean `HOME`, `XDG_CONFIG_HOME`, `TAKEONE_NO_KEYRING=1` and a node-only PATH it exits 3 with the one `takeone needs an AI engine` line and writes no storyboard.
4. Look at frames, not numbers: decode the first, a mid and the last frame of every segment scene and one footage frame from `out/scenes/` and put them on a contact sheet. The intro, callout and outro must be the page's own picture (not blank, not the footage), the footage scenes must be the board, and no text may sit outside the 5% inset or be cut. Sample during the transitions (0.1 s into each segment), not only the settled hold.
5. Contract gates: a page with no `takeoneSegment.seek`, a page that fetches a URL, a page whose text leaves the 5% inset and a page that throws each fail the render naming the page and the cause (`test/motion-segment.test.ts` drives all four).
6. Capture: the contact sheet to `$DONE_DONE_EVIDENCE_ROOT/takeone-segments-after.png` and the film to `takeone-segments-after.mp4`.

The drive changes no repo file: note findings in the run's report.
