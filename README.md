<h1 align="center">
  <img src="docs/assets/readme/icon.png" width="72" alt="" valign="middle" /> takeone
</h1>

<p align="center">
  <a href="https://github.com/umeranjum17/takeone/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/umeranjum17/takeone/actions/workflows/ci.yml/badge.svg" /></a>
</p>

<p align="center">
  <strong>Record once. Direct the camera afterwards.</strong><br/>
  takeone is a private screen-recording studio that turns a raw capture into a polished demo. You demonstrate your app the way you normally use it; takeone then plans every zoom, hold and pan from what actually happened on screen, and renders a framed, paced MP4 locally.
</p>

<p align="center">
  <picture><source srcset="docs/assets/readme/hero.webp" type="image/webp"><img src="docs/assets/readme/hero.jpg" alt="A takeone render of a project board: the camera holds the New task dialog while High is picked from the Priority dropdown, pulls back to the whole board as the Task created toast appears, then pushes in on the new card as it is dragged into In progress, with a blue ring marking each click" width="960" /></picture>
</p>

## Why takeone exists

A good product demo needs camera work: push in on the control you click, hold the dialog you type into, pull back when the result lands. Doing that while you demonstrate means performing and directing at the same time, and a full-screen 4K capture is unreadable on a phone or in a feed.

takeone splits the two jobs. Recording is only recording. Camera work is planned after the take, from the input events and screen changes it logged, at a bounded, measured cost of about $0.0006 per minute of video. Rendering is local ffmpeg work and costs nothing.

## See it in action

Every capture below is real takeone output: stills from a 62.7 s take of a staged, fictional project board, recorded through the view-only portal capture, and one synthetic take rendered with the current code. Nothing is mocked.

### Plan the camera after you record

The recorder keeps the whole 3840×2160 screen and the input events. `make` picks what matters at each moment and frames it, so the Priority dropdown that is a few pixels tall in the raw capture fills the shot in the render.

<p align="center">
  <picture><source srcset="docs/assets/readme/before-after.webp" type="image/webp"><img src="docs/assets/readme/before-after.jpg" alt="Left, the raw 3840×2160 capture of the whole board with a small New task dialog and its Priority dropdown open; right, takeone's render of the same step, framed on the dialog so the Low, Normal, High and Urgent options are readable" width="960" /></picture>
</p>

### Hold the whole panel

When a click opens a panel or dialog, the shot holds all of it. While you type, the camera keeps the whole form in frame (title, notes, priority and buttons) instead of chasing the caret.

<p align="center">
  <picture><source srcset="docs/assets/readme/typing.webp" type="image/webp"><img src="docs/assets/readme/typing.jpg" alt="The New task dialog held whole while notes are typed: the Title reads Draft launch announcement, the focused Notes field reads Two short paragraphs and a link to t, and Priority, Cancel and Create task stay in frame" width="720" /></picture>
</p>

### Every click shows

Each click and drag press gets a press dot and an expanding accent ring with a white halo. The ring is drawn in source space, so it zooms with the content.

<p align="center">
  <picture><source srcset="docs/assets/readme/drag.webp" type="image/webp"><img src="docs/assets/readme/drag.jpg" alt="A close shot of the To do column as the Draft launch announcement card is lifted for a drag, a blue ring around the pointer marking the press" width="720" /></picture>
</p>

### A stage, not a screenshot

At rest the screen sits as a rounded card with a soft shadow on a gradient. The margin eases away as the camera zooms, so close-ups are all screen, and the video fades in and out on the stage colour.

<p align="center">
  <picture><source srcset="docs/assets/readme/stage.webp" type="image/webp"><img src="docs/assets/readme/stage.jpg" alt="The whole board as a rounded card on a dark gradient stage, just after a click on the New task button, which carries a blue click ring, with the empty New task dialog open" width="720" /></picture>
</p>

### Close-ups that stay crisp

Zoom never upscales source pixels more than 1.5×, and the camera path runs through a critically damped spring, so moves ease in and out without overshoot or jitter.

<p align="center">
  <picture><source srcset="docs/assets/readme/close-up.webp" type="image/webp"><img src="docs/assets/readme/close-up.jpg" alt="A tight, sharp close-up of the board's overflow menu open under the pointer, listing Export board as CSV, Archive done tasks and Board settings above the Activity feed" width="720" /></picture>
</p>

### Titles and captions

Add a `title` and timed `captions` to `take.json` and they render as rounded pills near the bottom. Caption times are source-video seconds, and reading time survives idle squeezing.

<p align="center">
  <picture><source srcset="docs/assets/readme/captions.webp" type="image/webp"><img src="docs/assets/readme/captions.jpg" alt="A synthetic analytics app zoomed on a Churn analysis draft panel while its Retention slider is dragged, with the caption pill Drag to adjust retention below it" width="720" /></picture>
</p>

## How it works

1. **Record.** `takeone record` captures the desktop through desklink's view-only portal session and, when evdev is readable, the pointer, clicks, wheel, key classes and focused window. Typed characters are never recorded.
2. **Make.** `takeone make` segments the take into beats (at most 30 per minute), finds the regions that changed, and decides each beat's shot. Jev decides the beats that need judgement, from zone descriptions and an optional `--about` topic; idle and cut beats are decided locally. A token preflight refuses the whole run before any call if the plan would exceed its cap, and `--no-jev` keeps every decision local.
3. **Render.** The camera path is solved on the output clock, eased through a spring and rendered with ffmpeg and libass into a silent 1920×1080 H.264 MP4: stage, click rings, idle speed-up, titles and captions. Rerendering with new `--set` values never calls the planner.

## Download / Install

No packaged release exists yet — there is nothing to download. Watch the [releases page](https://github.com/umeranjum17/takeone/releases) (latest: https://github.com/umeranjum17/takeone/releases/latest) for future packaged builds. Until then, install from source:

Requires Node.js 22+ and `ffmpeg` on PATH. Optional: `tesseract` for `--screen-text` OCR. Recording additionally needs Linux on Wayland with Hyprland (see [Recording](#recording-linuxwaylandhyprland)); planning and rendering an existing take do not.

```sh
git clone https://github.com/umeranjum17/takeone
cd takeone
npm install        # also builds dist/
npm link           # optional: puts `takeone` on PATH
takeone doctor     # report what the recorder needs on this machine
```

Run `node bin/takeone.mjs` from the checkout, or `takeone` if the package is linked. Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`.

## Quickstart

**1. Render a demo without recording anything.** `scripts/synth-take.ts` generates a complete take: a scripted 44 s 1920×1080 UI demo (dashboard → search → list scroll → detail → slider drag → export toast) drawn entirely with ffmpeg filters, plus matching `take.json`, `frames.tsv`, and `events.jsonl`.

```sh
node scripts/synth-take.ts /tmp/takes/synth-demo
node bin/takeone.mjs make /tmp/takes/synth-demo --no-jev
```

The polished video lands at `/tmp/takes/synth-demo/out/synth-demo.mp4`, next to the plan in `analysis/` and the camera path in `camera.json`. `--no-jev` makes this run offline at zero tokens.

**2. Let Jev plan the camera.** Put `TYPESAFE_API_KEY=...` in your environment or in `~/.config/takeone/env`, then re-run `make` without `--no-jev`. Add `--about "what the demo shows"` for better key moments.

**3. Record your own take** (Linux, Wayland, Hyprland):

```sh
takeone record                # grant the screen-share consent; share only the output you are demoing
# ...demonstrate your app...
takeone stop
takeone                       # list takes, newest first
takeone make <id> --about "Creating a task and moving it across a project board"
```

**4. Tweak the look and rerender** without planning again:

```sh
takeone render ~/Videos/takeone/<id> --set background=#0B1220 --set idle_speed=3
```

## Plan and render

```sh
node bin/takeone.mjs make <id> [--no-jev] [--about "topic"] [--screen-text] [--max-tokens N] [--set key=value]
node bin/takeone.mjs render /path/to/take [--set fps=24]
```

`<id>` can also be an absolute take-directory path. `make` writes `analysis/regions.json`, `analysis/actions.json`, renderer-format `analysis/beats.json` (video-relative seconds), and one decision per line in `analysis/decisions.jsonl`; Jev responses are cached separately in `analysis/jev-cache.jsonl`. It updates `take.json` with usage and render metadata, then writes `camera.json`, `camera.cmd`, and `out/<id>.mp4`. Re-running `make` can reuse cached responses. A trim must overlap the video; only that overlap is planned. Beats are capped at 30 per minute, which may merge idle gaps.

With `TYPESAFE_API_KEY` (or a key in `~/.config/takeone/env`), Jev receives zone descriptions and an optional `--about` topic. Without a key, or with `--no-jev`, decisions stay local; failed calls fall back to a local heuristic. Screen text and window titles are not sent by default. `--screen-text` opts in to OCR (with `tesseract` on PATH) and sending filtered text and window labels: each OCR token and each whitespace-delimited window-title word is sent only if it has 2–15 ASCII letters; every other token is `[redacted]`. OCR fragments are not joined. The preflight refuses planned Jev requests above `--max-tokens` (default 40,000 per take minute); `--no-jev` skips calls entirely.

### Render an existing take

For an existing planned take, render reads `screen.webm`, `take.json` (at least `width` and `height` in source pixels), `analysis/beats.json` as a beat array, and `analysis/decisions.jsonl` as one decision per line. Each beat needs a matching decision whose A (and optional B) names refer to that beat's zones. For an existing take, `events.jsonl` may be omitted only when `take.json` has `"events": "none"`; an empty event file is also valid.

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`; rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`, and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default 1920×1080 at 30 fps). Whole-screen shots of non-16:9 sources are centred on the stage background rather than cropped; zooming can crop the screen. If `take.json` omits `id`, the directory name is used; if it omits `trim_end`, the latest beat end is used.

## Cost per minute of video (measured)

About **14–15k Jev input tokens, roughly $0.0006, per minute of video**, with a hard ceiling of 36k tokens (about $0.0015) per minute at the defaults.

Measured on a real 62.7 s desktop take recorded on Hyprland at 3840×2160 (`scripts/e2e`, below). The run used a live Jev key, `--about` set, and no cache:

| Metric | Measured | Per minute of video |
|---|---|---|
| Beats (Jev / local) | 20 (12 / 8) | 19 |
| Jev requests | 15 | 14 |
| Jev input tokens | 14,715 | ~14,100 |
| Jev cost | $0.000618 | ~$0.00059 |
| Largest request | 1,099 tokens | — |
| Failed calls | 0 | 0 |
| `make` wall clock (plan + render, machine at load ~100) | 28–111 s | ~27–106 s |

Three clean live runs of the same take, from successive code states, landed between 14.7k and 15.8k input tokens. The preflight planned 22,000 tokens for this take against its 41.8k cap, so it held. Idle and cut beats are decided locally and cost nothing. Jev's `usage.input_tokens` is summed into `take.json` (`jev.input_tokens`, `jev.usd`).

With `--no-jev` the cost is exactly zero tokens. Responses are cached per request hash (`analysis/jev-cache.jsonl`), so replanning an unchanged take costs nothing.

The cost is bounded by design, not by luck:

- **Beat cap**: at most 30 beats per minute (`MAX_BEATS_PER_MIN` in `src/beats/segment.ts`), so the number of Jev calls never grows with how busy the recording is.
- **Token preflight**: `make` estimates every planned request up front and refuses the whole run (`PreflightRefusal`) when the reserved total exceeds `--max-tokens`, default 40,000 input tokens per take minute (`DEFAULT_TOKENS_PER_MIN` in `src/make.ts`). Each single request is also hard-capped at `REQUEST_TOKEN_CAP` (1,200 estimated tokens) in `src/decide/request.ts`.

Worst case at the defaults: 30 calls/minute × 1,200 tokens ≈ 36,000 tokens ≈ $0.0015 per minute of video at the listed price — under the 40k/minute cap. The measured take above used 39% of that at 19 beats/minute. Rendering costs no tokens at any setting.

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

## End-to-end take with a staged scene

`scripts/e2e` records a harmless real take without touching your own apps. It is how the captures above were made:

- `scene.sh start PROFILE_DIR [WORKSPACE]` opens `scene.html` fullscreen on an empty Hyprland workspace (default 9). The page is a fictional project board with dummy content, run in a throwaway Chromium profile.
- `drive.py serve FIFO` creates a uinput virtual mouse and keyboard (group `input`), so the recorder's evdev taps see real kernel events.
- `echo scene > FIFO` plays ~60 s of clicks, typing, a dropdown, a drag, scrolling and a menu against the scene's fixed geometry.

```sh
python3 scripts/e2e/drive.py serve /tmp/drive.fifo &      # before recording: taps enumerate devices at start
scripts/e2e/scene.sh start ~/lab/scene-profile
takeone record &                                         # share only the output that shows the scene
echo scene > /tmp/drive.fifo; sleep 65; takeone stop
scripts/e2e/scene.sh stop ~/lab/scene-profile 1          # return to your workspace
takeone make <id> --about "Creating a task and moving it across a project board"
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

### Commands

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

### Files of a take

Recording creates a take directory with `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl`:

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
