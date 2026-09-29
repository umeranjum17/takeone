# takeone

takeone is a private screen-recording studio for turning a raw capture into a polished demo. Camera work is planned after recording, not while you demonstrate an app. Recording is not yet available here.

Requires Node.js 22+ and `ffmpeg` on PATH. Put `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl` in a take directory (`events.jsonl` may be omitted only when `take.json` has `"events": "none"`). Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`.

```sh
node bin/takeone.ts make <id> [--no-jev] [--about "topic"] [--screen-text] [--max-tokens N]
node bin/takeone.ts render /path/to/take [--set fps=24]
```

`<id>` can also be an absolute take-directory path. `make` writes `analysis/regions.json`, `analysis/actions.json`, renderer-format `analysis/beats.json` (video-relative seconds), and one decision per line in `analysis/decisions.jsonl`; Jev responses are cached separately in `analysis/jev-cache.jsonl`. It updates `take.json` with usage and render metadata, then writes `camera.json`, `camera.cmd`, and `out/<id>.mp4`. Re-running `make` can reuse cached responses. A trim must overlap the video; only that overlap is planned. Beats are capped at 30 per minute, which may merge idle gaps.

With `TYPESAFE_API_KEY` (or a key in `~/.config/takeone/env`), Jev receives zone descriptions and an optional `--about` topic. Without a key, or with `--no-jev`, decisions stay local; failed calls fall back to a local heuristic. Screen text and window titles are not sent by default. `--screen-text` opts in to OCR (with `tesseract` on PATH) and sending filtered text and window labels: each OCR token and each whitespace-delimited window-title word is sent only if it has 2–15 ASCII letters; every other token is `[redacted]`. OCR fragments are not joined. The preflight refuses planned Jev requests above `--max-tokens` (default 40,000 per take minute); `--no-jev` skips calls entirely.

## Render an existing take

For an existing planned take, render reads `screen.webm`, `take.json` (at least `width` and `height` in source pixels), `analysis/beats.json` as a beat array, and `analysis/decisions.jsonl` as one decision per line. Each beat needs a matching decision whose A (and optional B) names refer to that beat's zones.

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`; rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`, and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default 1920×1080 at 30 fps). Whole-screen shots of non-16:9 sources are centred with padding in the export background (`#202124` by default) rather than cropped; zooming can crop the screen. Set the padding colour with `--set background=#RRGGBB`. If `take.json` omits `id`, the directory name is used; if it omits `trim_end`, the latest beat end is used.

## Cost per minute of video (measured)

Measured on a synthetic 44 s 1920×1080 take (`scripts/synth-take.ts`) with a live Jev key, 5 beats, `--about` set:

| Metric | Measured | Per minute of video |
|---|---|---|
| Jev input tokens | 8,719 | ~11,900 |
| Jev cost | $0.000366 | ~$0.0005 |
| Failed calls | 0 | 0 |
| `make` wall clock (plan + render) | 7.5 s | ~10 s |

With `--no-jev` the cost is exactly zero tokens and the same run plans in under a second. Responses are cached per request hash (`analysis/jev-cache.jsonl`), so replanning an unchanged take costs nothing.

The cost is bounded by design, not by luck:

- **Beat cap**: at most 30 beats per minute (`MAX_BEATS_PER_MIN` in `src/beats/segment.ts`), so the number of Jev calls never grows with how busy the recording is.
- **Token preflight**: `make` estimates every planned request up front and refuses the whole run (`PreflightRefusal`) when the reserved total exceeds `--max-tokens`, default 40,000 input tokens per take minute (`DEFAULT_TOKENS_PER_MIN` in `src/make.ts`). Each single request is also hard-capped at `REQUEST_TOKEN_CAP` (1,200 estimated tokens) in `src/decide/request.ts`.

Worst case at the defaults: 30 calls/minute × 1,200 tokens ≈ 36,000 tokens ≈ $0.0015 per minute of video at the listed price — under the 40k/minute cap. Rendering costs no tokens at any setting.

## Synthetic take for tests and demos

`scripts/synth-take.ts` generates a complete take with no screen capture: a scripted 44 s 1920×1080 UI demo (dashboard → search → list scroll → detail → slider drag → export toast) drawn entirely with ffmpeg filters, plus matching `take.json`, `frames.tsv`, and `events.jsonl`.

```sh
node scripts/synth-take.ts /tmp/takes/synth-demo
node bin/takeone.ts make /tmp/takes/synth-demo
```
