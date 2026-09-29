# takeone

takeone is a private screen-recording studio for turning a raw capture into a polished demo. Camera work is planned after recording, not while you demonstrate an app. Recording is available through desklink's view-only portal capture.

Requires Node.js 22+ and `ffmpeg` on PATH. Recording creates a take directory with `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl`. For an existing take, `events.jsonl` may be omitted only when `take.json` has `"events": "none"`; an empty event file is also valid. Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`. Run `node bin/takeone.mjs` below, or `takeone` if the package is linked.

## Plan and render

```sh
node bin/takeone.mjs make <id> [--no-jev] [--about "topic"] [--screen-text] [--max-tokens N]
node bin/takeone.mjs render /path/to/take [--set fps=24]
```

`<id>` can also be an absolute take-directory path. `make` writes `analysis/regions.json`, `analysis/actions.json`, renderer-format `analysis/beats.json` (video-relative seconds), and one decision per line in `analysis/decisions.jsonl`; Jev responses are cached separately in `analysis/jev-cache.jsonl`. It updates `take.json` with usage and render metadata, then writes `camera.json`, `camera.cmd`, and `out/<id>.mp4`. Re-running `make` can reuse cached responses. A trim must overlap the video; only that overlap is planned. Beats are capped at 30 per minute, which may merge idle gaps.

With `TYPESAFE_API_KEY` (or a key in `~/.config/takeone/env`), Jev receives zone descriptions and an optional `--about` topic. Without a key, or with `--no-jev`, decisions stay local; failed calls fall back to a local heuristic. Screen text and window titles are not sent by default. `--screen-text` opts in to OCR (with `tesseract` on PATH) and sending filtered text and window labels: each OCR token and each whitespace-delimited window-title word is sent only if it has 2–15 ASCII letters; every other token is `[redacted]`. OCR fragments are not joined. The preflight refuses planned Jev requests above `--max-tokens` (default 40,000 per take minute); `--no-jev` skips calls entirely.

## Render an existing take

For an existing planned take, render reads `screen.webm`, `take.json` (at least `width` and `height` in source pixels), `analysis/beats.json` as a beat array, and `analysis/decisions.jsonl` as one decision per line. Each beat needs a matching decision whose A (and optional B) names refer to that beat's zones.

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`; rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`, and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default 1920×1080 at 30 fps). Whole-screen shots of non-16:9 sources are centred on the stage background rather than cropped; zooming can crop the screen. If `take.json` omits `id`, the directory name is used; if it omits `trim_end`, the latest beat end is used.

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

## Look and pacing

Every render uses the same stage, all local ffmpeg/libass work at zero token cost:

- **Stage**: at rest the screen sits as a rounded card (`corner_radius`, output px) with a soft drop shadow (`shadow`, opacity 0–1) on a diagonal gradient from `background` to `background_to`, inset by `stage_margin` (fraction of the stage size). The margin eases away as the camera zooms, so close-ups are all screen.
- **Zoom**: shots never upscale source pixels more than `max_upscale` (1.5): a clear push-in on a 1080p capture that keeps text crisp. The camera path runs through a critically damped spring (`lowpass_omega`), so moves ease in and out without overshoot. When a click opens a panel or dialog (a change region holding the click, up to half the screen), the shot holds the whole panel: per-level padding never widens a shot past `frame_max` (0.8) of the screen, and the zone itself always keeps `hold_pad` (1.08x) around it.
- **Bookends**: the first shot waits `establish_s` so the viewer sees the whole screen first, and the camera settles back to the whole stage for the last `outro_s` (0 keeps the last shot). The video fades in from and out to `background_to` over `fade_s`.
- **Clicks**: every click and drag press gets a press dot and an expanding `accent` ring with a white halo, lasting `ripple_ms` (0 turns it off) and growing to `ripple_r` output px at rest. The ripple is drawn in source space, so it zooms with the content.
- **Pacing**: idle stretches between actions play `idle_speed` times faster (1 turns it off), keeping `idle_keep` seconds of real time around every action. The camera is solved on the output clock, so moves keep their natural speed.
- **Titles and captions**: optional `title` and `captions` in `take.json` render as rounded pills near the bottom in `caption_font` at `caption_size` px (the title is 1.4× larger). Caption times are source-video seconds; `d` (default 3) is on-screen seconds, so reading time survives idle squeezing.

```json
{ "title": "Find any report in seconds",
  "captions": [{ "t": 8.4, "text": "Search filters as you type" }, { "t": 22.6, "d": 3.6, "text": "Drag to adjust retention" }] }
```

Colours take `--set key=#RRGGBB`; `caption_font` takes letters, digits and spaces (`--set "caption_font=Inter SemiBold"`); fontconfig substitutes a system sans when the font is missing.

## Synthetic take for tests and demos

`scripts/synth-take.ts` generates a complete take with no screen capture: a scripted 44 s 1920×1080 UI demo (dashboard → search → list scroll → detail → slider drag → export toast) drawn entirely with ffmpeg filters, plus matching `take.json`, `frames.tsv`, and `events.jsonl`.

```sh
node scripts/synth-take.ts /tmp/takes/synth-demo
node bin/takeone.mjs make /tmp/takes/synth-demo
```

## Recording (Linux/Wayland/Hyprland)

Private. Runs on your own machine. Linux (Wayland/Hyprland) only.

`takeone record` captures the desktop and, when evdev is readable, the input
events that drive the later camera decisions. Capture is delegated entirely to
[desklink](https://github.com/umeranjum17/desklink) (`@desklink/host`, unchanged
dependency): takeone spawns `desklink-host serve`, opens a **view-only** portal
session (the compositor may show a screen-share consent dialog),
answers the engine's SDP offer with [werift](https://github.com/shinyoshiaki/werift),
and writes the received VP9 track to `screen.webm` without re-encoding.

Input sources are read passively, never grabbed. If evdev mouse or keyboard devices are missing or unreadable, recording continues video-only (`events: "none"`); unavailable Hyprland IPC or an unmatched monitor disables pointer and window events:

- pointer position and focused window from the Hyprland IPC sockets, mapped into
  stream pixels (with a self-check that falls back to no-pointer mode when no
  monitor matches the stream size within 2 px)
- clicks, wheel and key *classes* from every mouse and keyboard in `/proc/bus/input/devices`
  (USB, Bluetooth, touchpads and virtual devices alike),
  opened non-blocking and polled. Key records are classes only
  (`char|space|enter|backspace|tab|esc|nav|mod|fn`) plus a shortcut name like
  `Ctrl+S` when a non-Shift modifier is held. F13–F24 retain named shortcuts;
  media keys are classified as `fn` without shortcut names, so they do not
  create typing actions. **Typed characters are never recorded.**

## Commands

```
takeone                 list takes (newest first)
takeone record          record the desktop until `takeone stop`
  [--fps 30] [--bitrate 40000]
  [--root DIR]          takes root (default ~/Videos/takeone, env TAKEONE_DIR)
  [--state-dir DIR]     state dir (default ~/.local/state/takeone, env TAKEONE_STATE_DIR)
takeone stop            stop the active recording (SIGINT to the pid file)
takeone doctor          report what the recorder needs on this machine
```

If recording with `--state-dir DIR`, set `TAKEONE_STATE_DIR=DIR` for `takeone stop` (and bare `takeone`); those commands read the state directory from the environment, not the record option.

Recorder command output is TOON. Recorder errors are structured JSON on stderr:
`{"error":{"code","message","hint"}}`. A cancelled consent dialog is a
`consent-cancelled` error and is never retried or bypassed.

## Files of a take

```
~/Videos/takeone/<YYYYMMDD-HHMMSS>/
  screen.webm     VP9 from desklink, not re-encoded
  frames.tsv      one `rtp_ts<TAB>recv_mono_ns` line per frame (marker-bit packets)
  events.jsonl    pointer/clicks/wheel/key-classes/window events, ms since take start (may be empty)
  take.json       geometry, monitor, clock offset, auto-trim, engine metrics, versions
```

The portal restore token is persisted atomically at
`~/.local/state/takeone/portal-token` (0600) and consumed before reuse; a token
is single-use, so a consent dialog appears whenever the portal does not grant
silent restoration.

## Development

```
npm install
npm test        # builds, then runs planner/renderer and recorder tests
```

The test suite is offline: mapping math, key-classification (with an assertion
that no key record ever carries a character), evdev byte parsing, clock
alignment, token persistence, take listing, CLI shapes — plus a loopback
integration test in which a fake `desklink-host` process (a real werift VP9
sender speaking the same stdio protocol) records a take through the full
`takeone record` path, stopped by SIGINT exactly as `takeone stop` does.
