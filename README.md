# takeone

takeone is a private screen-recording studio for turning a raw capture into a polished demo. Camera work is planned after recording, not while you demonstrate an app.

This slice implements the planner only: `make` analyzes a recorded take and chooses camera targets. Recording, camera paths and rendering are not yet available here.

Requires Node.js 22+ and `ffmpeg` on PATH. Put `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl` in a take directory (`events.jsonl` may be omitted only when `take.json` has `"events": "none"`). Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`.

```sh
node bin/takeone.ts make <id> [--no-jev] [--about "topic"] [--screen-text] [--max-tokens N]
```

`<id>` can also be an absolute take-directory path. The planner writes `analysis/regions.json`, `actions.json`, `beats.json`, `decisions.json`, and a request cache in `analysis/decisions.jsonl` when Jev responds; it updates `take.json` with Jev usage. Re-running `make` redoes perception and segmentation but can reuse cached decisions.

With `TYPESAFE_API_KEY` (or a key in `~/.config/takeone/env`), Jev receives zone descriptions and an optional `--about` topic. Without a key, or with `--no-jev`, decisions stay local; failed calls fall back to a local heuristic. Screen text and window titles are not sent by default. `--screen-text` opts in to OCR (with `tesseract` on PATH) and sending redacted text and window labels. The preflight refuses planned Jev requests above `--max-tokens` (default 40,000 per take minute); `--no-jev` skips calls entirely.
