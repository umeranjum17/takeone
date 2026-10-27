# Add keycaps, spotlights and blur to a take

Part of the takeone verification map. Source: `src/render/overlays.ts`, `src/keyclass.ts`, `src/render/edits.ts`, `scripts/synth-overlays.ts`, `scripts/prove-overlays.ts`. Full description and the saved proof: `docs/overlays.md`.

## How to get to it (user POV)

A shortcut the user pressed while recording (Ctrl, Alt or Meta plus a key) shows as keycaps in a frosted pill above the caption band; `--set keycap_style=mac` draws macOS glyphs. The user adds `"spotlight"` and `"blur"` regions (`{ "t", "d", "rect": [x, y, w, h] }` in source pixels and video seconds) to `take.json`, then runs `takeone render <take-dir>`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Copy the planned board take from [Plan and render a recorded take](plan-and-render-a-recorded-take.md) first.

1. Spotlight and blur on a real take: add `"spotlight": [{"t": 3, "d": 4, "rect": <the open dialog's box>}]` and `"blur": [{"t": 0, "d": 8, "rect": <a card title's box>}]` to the copy's `take.json` (boxes from `text-boxes.json`), then `node bin/takeone.mjs render <copy>`. Exit 0. An invalid region (zero size, outside the source) must fail with its field and index.
2. Look at whole frames inside the windows: the spotlight hole keeps the footage unchanged and sharp inside rounded, feathered edges while the surround is blurred and cool-dimmed; only the blur patch is blurred and nothing else; both follow the camera.
3. Keycaps need a take whose `events.jsonl` carries a modifier combo: a real desktop recording (`takeone record`), or the saved recording `node scripts/prove-overlays.ts <saved-input-dir> <evidence-dir>` reuses. The board scene types characters only and shows no keycap. `node scripts/synth-overlays.ts <dir>` rebuilds the light and dark keycap demo from `scripts/e2e/scene.html` in its own headless browser (needs `chrome-devtools-axi`); it is a fixture demo, not acceptance. Check frames during each keycap hold: the pill sits bottom-centre, never over a spotlight, blur or caption, and `Ctrl+NEVER_RENDER_THIS`-style malformed combos draw nothing.
4. Capture: stills inside the spotlight and blur windows to $DONE_DONE_EVIDENCE_ROOT/takeone-overlays-after.png (side by side) and, when a keycap take was driven, a still during its hold to $DONE_DONE_EVIDENCE_ROOT/takeone-overlays-keycap-after.png.

The drive changes no repo file: note findings in the run's report.
