# Core journey: record, stop, plan, render

`done-done run core` is the proof that the product's main path works on a take the run recorded itself, not on a synthetic one. `scripts/verification/core-journey.sh <work-dir> <evidence-dir>` does it end to end:

1. Starts an Xvfb display of its own and opens the staged Tidewater board (`scripts/e2e/scene.html`, fictional content) fullscreen in a throwaway Chromium profile. No personal screen is ever recorded.
2. Records that display with `takeone capture record --source x11:<display>`. The shipped `takeone record` needs a person to click a portal consent, which a script cannot grant (and must not bypass); `--source x11` is the same recorder pointed at an explicit display.
3. Uses the board as a person would: opens a task, types a title and notes, sets a priority, creates it, drags a card, exports the board as CSV.
4. Stops with the shipped `takeone stop`.
5. Plans and renders the new take with `takeone make` on the recorded engine (`scripts/verification/recorded-engine.sh`): no account, key or network.
6. Writes the evidence: the command log, the recorder's log, `take.json`, the plan and beats, ffprobe JSON of the recording and the film, a still of the source board, of the recording and of the film, a contact sheet and the film.

Run it through the memory gate and render slot (`TAKEONE_RENDER_WRAP`). The script needs `Xvfb`, `chromium`, `ffmpeg` and `chrome-devtools-axi`.

## The offline recipe is separate

Rendering a demo with nothing recorded (a synthetic take from `scripts/synth-take.ts` planned by the recorded engine) is [offline-demo-render.md](offline-demo-render.md) and the `offline-render` journey. It proves the render pipeline with zero capture hardware; it does not prove recording, and the core journey does not stand in for it. Neither proof is folded into the other.
