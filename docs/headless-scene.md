# Reproducible board demo

The offline board fixture produces a normal take without opening a display,
portal, input device, phone, or account. All content is fictional; its demo user
is Umer. This is an asset-production script, not a new recording mode.

On Linux x86_64 with Node 22.18+, ffmpeg (libvpx-vp9), unzip and Chromium's shared
libraries installed:

```sh
node scripts/install-headless-shell.mjs
node scripts/headless-scene.mjs tmp/board-demo
node bin/takeone.mjs make tmp/board-demo --no-jev --set fps=60
node bin/takeone.mjs render tmp/board-demo --set fps=60
```

The output directory must be new; missing parent directories are created. The installer fetches
the pinned Chrome for Testing headless shell, verifies the archive
SHA-256, and stores it in the gitignored `.cache/headless-shell/` directory. Each
capture verifies the executable's SHA-256 and version. There are no new npm
dependencies. The pin, checksums and download URL are owned by
[`scripts/headless/shell.mjs`](../scripts/headless/shell.mjs).
Ubuntu's required shared libraries are listed in the `headless-scene` CI job.

The existing board and desktop driver use 2560×1440 layout coordinates. Headless
presentation scales that layout by 0.75 into a 1920×1080 CSS viewport, rendered
at device scale factor 2. The source is therefore exactly 3840×2160. The
choreography creates two tasks, types notes, selects priority, drags a card,
scrolls the activity feed, completes a task and archives completed cards.

Node's built-in WebSocket sends CDP commands to a throwaway browser profile.
Frame numbers drive the virtual JavaScript clock, timeout callbacks and paused
CSS animations. Native CSS transitions and caret blinking are disabled in this
fixture's headless presentation. Input uses CDP mouse/key dispatch; feed scrolling
is synchronous to avoid the browser's asynchronous wheel queue. The cursor is
baked into the source, matching existing recordings. PNG frames are streamed to
ffmpeg with backpressure, and encoded as lossless VP9 in yuv420p at constant 60 fps.

The output follows the [take directory format](../README.md#files-of-a-take).
Each captured frame has one TSV row, with a virtual receive time as integral
nanoseconds and zero clock offset.
Wheel deltas preserve the recorder's sign convention: negative scrolls down.
Pointer coordinates and window rectangles use stream pixels, buttons use the recorder schema, and keys contain
only classes and down/up state, never typed characters. Metadata carries the
browser pin and a deterministic start time. Capture failure removes its partial
take and closes its browser and encoder.

Run the complete acceptance gate locally or in CI:

```sh
node scripts/test-headless-scene.mjs
```

It captures the full sequence twice, checks every decoded frame with `framemd5`,
compares event logs and frame clocks, probes dimensions, 60 Hz timestamps and
frame count, then runs the unchanged `make --no-jev` pipeline and requires click,
drag and typing beats. WebM timestamps have millisecond precision: the gate
allows only the rounding of a 60 Hz sample to that timebase. A JSON report, decoded frame hashes and a 4×4 contact sheet of the render are retained under `tmp/headless-validation/` and uploaded by CI.
Determinism is checked between fresh runs on the same host. Moving the browser
pin, fonts or rendering flags requires rerunning that gate.
