# Reproducible board demo

The offline board fixture produces a normal take without opening a display,
portal, input device, phone, or account. All content is fictional; its demo user
is Umer. This is an asset-production script, not a new recording mode.

On Linux x86_64 with Node meeting the [installation requirements](guide.md#download--install), ffmpeg (libvpx-vp9), unzip and Chromium's shared
libraries installed:

```sh
node scripts/install-headless-shell.mjs
node scripts/headless-scene.mjs tmp/board-demo
node bin/takeone.mjs make tmp/board-demo --set fps=60 --set max_upscale=0.5
node bin/takeone.mjs render tmp/board-demo --set fps=60 --set max_upscale=0.5
```

Each export shape has its own layout of the same board. `--aspect=portrait` captures
the 1080×1920 layout (the nav becomes a strip, the three lanes narrow side by side,
the activity feed sits below them and the dialog is centred) and `--aspect=square`
the 1080×1080 one (the same, with compact cards and a shorter feed). Render each with
the matching `--aspect`, so the output shows the whole layout without a crop:

```sh
node scripts/headless-scene.mjs tmp/board-portrait --aspect=portrait
node bin/takeone.mjs make tmp/board-portrait --set fps=60 --aspect portrait
```

`--no-title` leaves the board's title out of `take.json`. A 16:9 render of a titled take keeps
a band under a smaller, top-anchored screen for the title. The untitled take fills the frame, so
use it for footage that another film frames and labels itself, as the demo film's sources are:

```sh
node scripts/headless-scene.mjs tmp/board-film --aspect=landscape --no-title
```

### Safe area

Every layout is fitted into its viewport inside a 5% inset on each side, and the take
records every visible text line, editable field, the open dialog and a shown toast in
`text-boxes.json` (stream px on the video clock, saved whenever they change). `render`
(and `make`) project those boxes through the final camera and stage, exactly as the
cursor overlay is placed, and exit 1 before encoding when any shown box crosses the
5% inset of the output, naming the first box, output frame and rectangle; the full
list is in `safe-area.json`. A box is judged where the frame paints it: a push-in
crops the screen card, so text the crop hides is not shown and not counted, and text
the crop edge cuts is measured where its visible part lands. A titled 16:9 take keeps
that card inside the inset, so its push-ins pass at the default 1920×1080; an untitled
take fills the frame and a push-in then paints board text inside the outer 5%, so pass
`max_upscale=0.5` to keep the 2× source at its rest framing. To prove camera
motion on a scene take, delete `text-boxes.json` from a copy: that take then carries
no safe-area acceptance.

`safe-area.json` also lists, per title and caption, the frames its box covers a shown
box (`frames`, `labels`) and its least clearance in output px to any of them
(`clearance`, `nearest`). The take writes each span its `role="status"` toast shows as a
`toasts` window in `take.json` and records the toast's box while it shows; every render keeps
captions in the band below the card, so no caption covers it.

The output directory must be new; missing parent directories are created. The installer fetches
the pinned Chrome for Testing headless shell, verifies the archive
SHA-256, and stores it in the gitignored `.cache/headless-shell/` directory. Each
capture verifies the executable's SHA-256 and version. There are no new npm
dependencies. The pin, checksums and download URL are owned by
[`scripts/headless/shell.mjs`](../scripts/headless/shell.mjs).
Ubuntu's required shared libraries are listed in the `headless-scene-part` CI job.

The existing board and desktop driver use 2560×1440 layout coordinates. Headless
presentation fits that layout (0.675) inside the safe inset of a 1920×1080 CSS
viewport, rendered at device scale factor 2. The source is therefore exactly
3840×2160 (2160×3840 portrait, 2160×2160 square, whose layouts are fitted at 0.9).
`--scale=3` (1 to 4) captures at that device scale factor instead, for footage that a
film crops to one lane: render it with `--set out_w=3240 --set out_h=5760` (portrait) so
the crop is not upscaled. The
choreography creates two tasks, types notes, selects priority, drags a card,
scrolls the activity feed, completes a task and archives completed cards.

Node's built-in WebSocket sends CDP commands to a throwaway browser profile.
Frame numbers drive the virtual JavaScript clock, timeout callbacks and paused
CSS animations. Native CSS transitions and caret blinking are disabled in this
fixture's headless presentation. Input uses CDP mouse/key dispatch; feed scrolling
is synchronous to avoid the browser's asynchronous wheel queue. Partial raster is
disabled so every repaint rasters the whole layer: partial raster re-rasterizes only
dirty tiles, and Skia's tile-clipped coverage can differ by a few levels from the
full raster on 1px rounded borders, so two captures of the same choreography could
decode to different frames after the first in-flight repaint. By default the
cursor is baked into the source, matching existing recordings. Pass
`--cursor=hidden` to paint no cursor and mark the take `cursor_free: true`, so the
renderer draws its own vector cursor from the pointer track instead
(see `verification/vector-cursor.md`). PNG frames are
streamed to ffmpeg with backpressure, and encoded as lossless VP9 in yuv420p at
constant 60 fps.

The output follows the [take directory format](recording.md#files-of-a-take).
Each captured frame has one TSV row, with a virtual receive time as integral
nanoseconds and zero clock offset.
Wheel deltas preserve the recorder's sign convention: negative scrolls down.
Pointer coordinates and window rectangles use stream pixels, buttons use the recorder schema, and keys contain
only classes and down/up state, never typed characters. Metadata carries the
browser pin and a deterministic start time. Capture failure removes its partial
take and closes its browser and encoder.

Run the complete acceptance gate locally or in CI:

```sh
node scripts/test-headless-scene.mjs                    # board
node scripts/test-headless-scene.mjs --aspect=portrait  # or --aspect=square
```

It captures the full sequence twice, checks every decoded frame with `framemd5`,
compares event logs and frame clocks, probes dimensions, 60 Hz timestamps and
frame count, then runs model-backed `make` (whose safe-area gate applies) and requires click,
drag and typing beats. WebM timestamps have millisecond precision: the gate
allows only the rounding of a 60 Hz sample to that timebase. A JSON report, decoded frame hashes (`a/frames.framemd5`) and a 4×4 contact sheet of the render are retained under `tmp/headless-validation/` and uploaded by CI.

CI splits the same gate into three parallel parts on separate runners and one
`headless-scene` check that compares them:

```sh
node scripts/test-headless-scene.mjs --part=capture   # capture-a and capture-b: one take and its checks
node scripts/test-headless-scene.mjs --part=render    # one take, its checks, then make and the contact sheet
node scripts/test-headless-scene.mjs --part=compare <take> <take> <take>  # identical frames, events and clocks
```

Locally, determinism is checked between fresh runs on the same host; in CI,
across three runners. Moving the browser pin, fonts or rendering flags requires
rerunning that gate.
