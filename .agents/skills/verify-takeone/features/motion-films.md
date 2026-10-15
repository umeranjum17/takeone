# Motion films from screens (`motion`)

Turn saved screens (images, HTML, or a URL) into a motion-design film without recording anything. `takeone motion` ingests the sources through a pinned headless shell, plans a storyboard (`hero-reveal`, `zoom-tour`, `end-card`), and renders an MP4 take offline.

## Sub-features

- Pattern planning: `--pattern hero-reveal,zoom-tour,end-card,kinetic-type` (all three when omitted); zoom-tour stops via `--region x,y,w,h[:caption][@SCREEN]`. With no `--pattern` and 3+ screens the planner builds a launch film: a kinetic-type title, each labelled screen announced by a full-type beat (message subtitle/CTA included; first beat also mounts a phone frame over a region close-up crop) ahead of a clean tour, a bento recap grid of real cropped screen states with 3+ labels, end card, black/cream beats alternating.
- Whole-UI framing: settled zoom-tour close-ups (render) and the phone/bento crops (ingest) keep a planned view that is already whole, else move to the tightest same-aspect framing that keeps every field, button and card whole or all but a sliver out (make's `detectUiBoxes`) and runs no edge through a word (`edgeCuts`). A stop or crop with no whole framing prints `motion: no framing of … keeps every word and control whole`; a snapped tour longer than its planned `d` prints `motion: whole-UI stops of scene N need …` and uses the planned stops. The bento's three state tiles each wear their label pill; the fourth tile has none.
- Interactive page states: `--state NAME='click #id; type #id "text"; wait 100'` captures real HTML/URL states in one page, in order.
- Copy chrome: `--title`, `--subtitle`, `--cta`, `--url`, `--logo`, `--device browser|phone|laptop|none`; theme tokens as elsewhere.
- Storyboard workflow: `--plan-only` writes an editable `storyboard.json` without ingest/render; `--storyboard file.json` renders a plan; `takeone render <dir>` rerenders the saved storyboard (motion takes reject `--theme`/`--set`).
- Real footage and type beats: storyboard `clips` (windows of real videos, optional per-file `crop`, cut to 60 fps frames at first render) feed `clip` scenes (a fitted window, typed mono label, `cuts` that retarget or hard-cut the footage); `statement` scenes set a centred title/subtitle/note. Each output plays the clip file whose own uncropped aspect is nearest its own. `takeone render <motion-dir> --aspect landscape|portrait|square|4:5` re-lays the same timeline at that size (`out/<id>-WxH.mp4`); `--stills 1.5,8.5` writes PNGs instead. The demo film is `resources/demo/film/storyboard.json` (its clip paths point at scratch takes; see docs/motion.md).
- Shell management: `takeone motion install-shell` fetches the sha256-pinned Linux x86_64 headless shell (needs network + `unzip`, once); `takeone doctor` reports its identity; `TAKEONE_CHROME` selects an existing matching shell.

## How to get to it (user POV)

The user has screenshots or an HTML page and wants a launch film: `takeone motion design.png --out takes/launch --theme editorial --title "Ship your next idea" --device browser`. The result is a take-shaped directory (`take.json`, `sources/`, `storyboard.json`, `out/<id>.mp4`, `render.json`) that `takeone list` shows and `takeone render` rerenders.

## Driving it with the takeone CLI

```sh
node bin/takeone.mjs motion install-shell                      # once per machine; verify via doctor afterwards
export TAKEONE_DIR="$PWD/tmp/verify-takes"
node bin/takeone.mjs motion /abs/design.png --out "$TAKEONE_DIR/verify-motion" \
  --pattern end-card --title "Ship your next idea" --device browser; echo "exit=$?"
```

Proving end state: exit 0; the output take dir contains `storyboard.json`, `sources/`, `render.json` (workers, shell, encoder, timing) and `out/<id>.mp4` that `ffprobe` reports as 1920×1080 (default). `--plan-only` alone proves planning only — it writes no MP4, so it is not render proof.

## Gotchas

- The first render needs the pinned headless shell installed (`install-shell`, network once); afterwards everything is offline. `doctor` reports the shell identity — check it before blaming the renderer.
- Motion pages reject CSS gradients (use SVG gradients/patterns) and enforce font glyph coverage: a rejected plan names the missing glyph; that is by design.
- Worker count is part of the render identity — keep `--workers` fixed between deterministic rerenders.
- Rerendering a motion take takes only `--aspect`/`--stills` (see docs/motion.md); edit `storyboard.json` for anything else — `render <motion-dir> --set …` is an error.
- Whole-UI proof: decode settled hold frames (`camera-scenes.json` constant runs) and look at them; snapped views can widen well past the planned region when a tight close-up would slice a dimmed card or field. `test/motion-glyph.test.ts` ("whole words, fields and buttons") is the journey gate.
- Ingest and encode are heavy — hold the shared heavy lock in fleet contexts.
- Clip footage proof: `--stills` PNGs at settled times, one sheet per aspect; check the 1:1 film shows the square file's crop (a crop's own aspect must not decide the file). `test/motion-glyph.test.ts` ("demo film storyboard") gates clip/cut validation.
