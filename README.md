# takeone

takeone is a private screen-recording studio for turning a raw capture into a polished demo. Camera work is planned after recording, not while you demonstrate an app. Recording is not yet available here.

Requires Node.js 22+ and `ffmpeg` on PATH. Put `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl` in a take directory (`events.jsonl` may be omitted only when `take.json` has `"events": "none"`). Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`.

```sh
node bin/takeone.ts make <id> [--no-jev] [--about "topic"] [--screen-text] [--max-tokens N]
node bin/takeone.ts render /path/to/take [--set fps=24]
```

`<id>` can also be an absolute take-directory path. The planner writes `analysis/regions.json`, `actions.json`, `beats.json`, `decisions.json`, and a request cache in `analysis/decisions.jsonl` when Jev responds; it updates `take.json` with Jev usage. Re-running `make` redoes perception and segmentation but can reuse cached responses. Its output is not yet compatible with `render`.

With `TYPESAFE_API_KEY` (or a key in `~/.config/takeone/env`), Jev receives zone descriptions and an optional `--about` topic. Without a key, or with `--no-jev`, decisions stay local; failed calls fall back to a local heuristic. Screen text and window titles are not sent by default. `--screen-text` opts in to OCR (with `tesseract` on PATH) and sending redacted text and window labels. The preflight refuses planned Jev requests above `--max-tokens` (default 40,000 per take minute); `--no-jev` skips calls entirely.

## Render an existing take

For an existing render-format take (not the output of `make`), render reads `screen.webm`, `take.json` (at least `width` and `height` in source pixels), `analysis/beats.json` as a beat array, and `analysis/decisions.jsonl` as one decision per line. Each beat needs a matching decision whose A (and optional B) names refer to that beat's zones.

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`; rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`, and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default 1920×1080 at 30 fps). Whole-screen shots of non-16:9 sources are centred with padding in the export background (`#202124` by default) rather than cropped; zooming can crop the screen. Set the padding colour with `--set background=#RRGGBB`. If `take.json` omits `id`, the directory name is used; if it omits `trim_end`, the latest beat end is used.
