# Core journey: record, stop, plan, render

`done-done run core` is the proof that the product's main path works on a take the run recorded itself, not on a synthetic one. `scripts/verification/core-journey.sh <work-dir> <evidence-dir>` does it end to end:

1. Starts an Xvfb display of its own and opens the staged Tidewater board (`scripts/e2e/scene.html`, fictional content) fullscreen in a throwaway Chromium profile. No personal screen is ever recorded.
2. Records that display with `takeone capture record --source x11:<display>`. The shipped `takeone record` needs a person to click a portal consent, which a script cannot grant (and must not bypass); `--source x11` is the same recorder pointed at an explicit display.
3. Uses the board as a person would: opens a task, types a title and notes, sets a priority, creates it, drags a card, exports the board as CSV.
4. Stops with the shipped `takeone stop`.
5. Plans and renders the new take with `takeone make` on the recorded engine (`scripts/verification/recorded-engine.sh`): no account, key or network.
6. Writes the evidence: the command log, the recorder's log, `take.json`, the plan and beats, ffprobe JSON of the recording and the film, a still of the source board, of the start and the end of the recording and of the film, a contact sheet and the film.

The journey fails, instead of passing quietly, when the page did not take what was typed: the new card must carry the typed title and High priority.

Run it through the memory gate and render slot (`TAKEONE_RENDER_WRAP`). The script needs `Xvfb`, `chromium`, `ffmpeg` and `chrome-devtools-axi`.

## The offline recipe is separate

Rendering a demo with nothing recorded (a synthetic take from `scripts/synth-take.ts` planned by the recorded engine) is [offline-demo-render.md](offline-demo-render.md) and the `offline-render` journey. It proves the render pipeline with zero capture hardware; it does not prove recording, and the core journey does not stand in for it. Neither proof is folded into the other.

## What this journey found

- **The film stops at the create.** The recording holds the whole drive, including the card drag and the CSV export (`takeone-core-record-end-frame.png` shows the card moved to In progress). The rendered film ends on the "Task created" toast, about 10 s long: `make` reads everything after the create as idle and the render trims it as trailing inactivity. An X11-source take has no input events (the evdev taps never see a browser driven over DevTools), and the card move changes under 1% of the pixels, so nothing marks it as an action. This is shipped behaviour and is recorded here, not worked around.
- **`ffprobe` warns on every recording.** `Unknown-sized element at 0x83 inside parent with finite size` comes from the live-written `screen.webm`; the stream still decodes and the warning is in the command log.
- **The take has a 30 s duration of mostly held frames** (about 110 recorded frames), so the recording probe's duration is the wall clock of the drive, not a measure of activity.
