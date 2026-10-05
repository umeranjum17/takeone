# Render a demo without recording anything

README Quickstart 1: generate a fully synthetic take (a scripted 44 s 1920×1080 UI demo drawn entirely with ffmpeg filters, with matching `take.json`, `frames.tsv`, `events.jsonl`), then plan and render it locally. This is the only journey that exercises the full `make` pipeline (beats → regions → decisions → camera → encode) with zero capture hardware, zero network and zero tokens, which makes it the default verification drive.

## Sub-features

- Synthetic take generation (`scripts/synth-take.ts`): video + events from one timeline spec.
- Local-only planning: `make --no-jev` decides every beat with the local heuristic, zero network calls.
- Render: stage, click rings, keycaps, idle speed-up, titles and captions from `take.json` baked into a silent H.264 MP4.

## How to get to it (user POV)

The user runs two commands from the checkout: `node scripts/synth-take.ts <dir>` to create the demo take, then `node bin/takeone.mjs make <dir> --no-jev` to plan and render it. The polished video lands at `<dir>/out/synth-demo.mp4`, next to the plan in `analysis/` and the camera path in `camera.json` + `camera.cmd`.

## Driving it with the takeone CLI

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" && mkdir -p "$TAKEONE_DIR"
node scripts/synth-take.ts "$TAKEONE_DIR/synth-demo"          # exit 0; writes take.json, screen.webm, frames.tsv, events.jsonl
node bin/takeone.mjs make "$TAKEONE_DIR/synth-demo" --no-jev  # exit 0; TOON progress on stdout
test -s "$TAKEONE_DIR/synth-demo/out/synth-demo.mp4"
node bin/takeone.mjs render "$TAKEONE_DIR/synth-demo" --set idle_speed=3   # optional rerender sanity, no planner
```

Proving end state: exit codes are 0; `out/synth-demo.mp4` exists and is a real video (`ffprobe` reports 1920×1080, duration well under the 44 s source — idle gaps are squeezed and the trailing inactivity after the last result is trimmed, so the export ends at that result plus `outro_s`; h264); `analysis/beats.json`, `analysis/decisions.jsonl`, `camera.json`, `camera.cmd` and `render.log` exist inside the take; `take.json` gained usage/render metadata. Extract one still from the MP4 for the evidence folder.

## Gotchas

- `synth-take.ts` needs one of its bundled font candidates present (Liberation/DejaVu/Adwaita on Linux) — it fails loudly otherwise; that is a real environment gap, not a bug to patch around.
- The take id is always `synth-demo` (from `take.json`), regardless of the directory name; the render lands in `out/synth-demo.mp4`.
- Both the synth draw and the encode are heavy ffmpeg work — hold the shared heavy lock in fleet contexts.
- Re-running `make` overwrites `analysis/`, `camera.json`, `camera.cmd` and `out/synth-demo.mp4` in place; copy the take first if you need the previous render for a before/after.
