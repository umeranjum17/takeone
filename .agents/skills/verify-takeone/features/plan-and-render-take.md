# Plan and render a recorded take (`make`)

The core pipeline: `takeone make <id>` segments an existing take into beats, finds changed regions, decides each beat's shot (locally, or via Jev when a key is stored), and renders the framed MP4. `<id>` is a take directory name under the takes root or an absolute take path.

## Sub-features

- Beat segmentation and change-region analysis (`analysis/regions.json`, `analysis/beats.json`, `analysis/actions.json`, one decision per line in `analysis/decisions.jsonl`).
- Local vs Jev planning: `--no-jev` keeps every decision local (zero network); with a stored key, Jev decides judgement beats inside a hard token preflight (`--max-tokens`, default 40k per take minute). Jev responses cache to `analysis/jev-cache.jsonl` — replanning an unchanged take costs nothing.
- `--about "<topic>"` adds a key-moment question; `--screen-text` opts in to redacted OCR (needs `tesseract`).
- Theme selection (`--theme NAME`) and camera-setting overrides (`--set key=value`) at plan time.
- Cost accounting: usage lands in `take.json` (`jev.input_tokens`, `jev.usd`).

## How to get to it (user POV)

After recording a take (feature 4) or creating one synthetically (feature 1), the user runs `takeone make <id>` — with `--about` for better key moments when Jev is enabled. The MP4 lands at `<take>/out/<id>.mp4` with the plan beside it in `analysis/`.

## Driving it with the takeone CLI

Offline verification drive (no key, no network, no capture):

```sh
node bin/takeone.mjs make /abs/path/to/take --no-jev --about "Creating a task and moving it across a board"; echo "exit=$?"
```

Proving end state: exit 0; `analysis/decisions.jsonl` has one line per decided beat; `out/<id>.mp4` exists and `ffprobe` reports the expected dimensions (default 1920×1080; 1080×1920 for portrait takes without `out_w`/`out_h` overrides); `take.json` carries updated usage/render metadata. For a Jev-enabled drive, additionally check `analysis/jev-cache.jsonl` exists and `take.json`'s `jev.input_tokens` is within the preflight cap — and treat it as a paid run: verification defaults to `--no-jev`.

Error shapes worth asserting: `takeone make: no take at <dir> (take.json missing)` exits 2; `PreflightRefusal` exits 2 with a message naming the token cap.

## Gotchas

- `make` without `--no-jev` and with a stored key performs real paid API calls; a token preflight refuses the run before any call if the plan would exceed the cap, but the verification default is `--no-jev`.
- Beats are capped at 30 per minute; idle gaps may merge — a shorter-than-raw output duration is expected, not a bug.
- A trim must overlap the video; only the overlap is planned.
- Recording-quality claims need human review of the rendered media; a passing encode does not qualify camera quality.
