# Recording

Private. Runs on your own machine.

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

`takeone record --android <serial>` records a phone or emulator into the same take directory format: H.264 video via the vendored scrcpy-server and touch input via `getevent`, hand-driven on the phone. `--touch-offset-ms N` calibrates touch timing; `--fps` and `--bitrate` are desktop-only. Requires `adb` on PATH and a device with USB debugging enabled.

`takeone record --ios-sim` records the booted iOS Simulator into the same take directory format, video-only: H.264 via `xcrun simctl io booted recordVideo`, hand-driven in the Simulator. There is no touch API, so no `events.jsonl` is written (`take.json` carries `"events": "none"` and `"pointer": "none"`) and the camera plans from screen changes alone. macOS only; requires Xcode with the iOS Simulator and `ffprobe` on PATH, plus a booted simulator. Use `--ios-udid <UUID>` to target a specific booted device when several are running. Invalid UUIDs and missing or shutdown devices are refused before capture starts. The default still uses simctl’s `booted` selection. `takeone stop` signals the recorder in `TAKEONE_STATE_DIR`, so use a task-specific state directory for isolated lab captures.

## Commands

```
takeone                 list takes (newest first)
takeone record          record the desktop until `takeone stop` (Linux/Wayland/Hyprland only)
  [--fps 30] [--bitrate 40000]
  [--root DIR]          takes root (default ~/Videos/takeone, env TAKEONE_DIR)
  [--state-dir DIR]     state dir (default ~/.local/state/takeone, env TAKEONE_STATE_DIR)
takeone record --android <serial>   record a phone or emulator until `takeone stop`
  [--touch-offset-ms N] calibration added to every touch timestamp (ms)
  [--root DIR] [--state-dir DIR] as above
takeone record --ios-sim   record the booted iOS Simulator until `takeone stop` (macOS only)
  [--root DIR] [--state-dir DIR] as above
takeone stop            stop the active recording (SIGINT to the pid file)
takeone doctor          report recorder requirements and motion-shell identity
```

If recording with `--state-dir DIR`, set `TAKEONE_STATE_DIR=DIR` for `takeone stop` (and bare `takeone`); those commands read the state directory from the environment, not the record option.

Recorder command output is TOON. Recorder errors are structured JSON on stderr:
`{"error":{"code","message","hint"}}`. A cancelled consent dialog is a
`consent-cancelled` error and is never retried or bypassed.

## Files of a take

Recording creates a take directory with `take.json`, `screen.webm`, `frames.tsv` and `events.jsonl` (`--ios-sim` takes omit `events.jsonl`):

```
~/Videos/takeone/<YYYYMMDD-HHMMSS>/
  screen.webm     VP9 from desklink, not re-encoded (H.264 from scrcpy-server for --android takes; H.264 from simctl, renamed from .mov, for --ios-sim takes)
  frames.tsv      one `rtp_ts<TAB>recv_mono_ns` line per frame (marker-bit packets); a single `0<TAB>0` line for --ios-sim takes
  events.jsonl    pointer/clicks/wheel/key-classes/window events, ms since take start (may be empty; omitted for --ios-sim takes)
  take.json       stream geometry plus recorder-specific metadata
```

The portal restore token is persisted atomically at
`~/.local/state/takeone/portal-token` (0600) and consumed before reuse; a token
is single-use, so a consent dialog appears whenever the portal does not grant
silent restoration.

## Recorder protocol conformance

The published `@byokit/record` 0.1.0 kit owns the unchanged recorder protocol v1.
TakeOne implements the recorder verbs directly and does not depend on the client kit. Its Jev
planner uses `@byokit/decide`; dependency versions are pinned in [package.json](../package.json).

Recorder protocol v1 was checked on 2026-09-30 against BYOKit main commit
`9ee18467275832afbe0a0211388b49ab08423c65`, using its unchanged
`packages/capture/src/testing/contract.ts` (`captureContract`) and `Capture` client.
TakeOne was built with `npm ci` and tested through the absolute path of this
checkout's executable `bin/takeone.mjs`, with the kit's clean HOME/XDG environment
and `PATH=/usr/bin:/bin`. Recording used only a throwaway Xvfb display
(`--source x11:<display> --events none`); the display was stopped after the run.

| Verb | Contract result |
|---|---|
| `hello` | Pass: protocol, capabilities and planner shape |
| `record` | Pass: recording/done, duration limit, abort and duplicate-record rejection |
| `stop` | Pass: abort stops the recording; idle stop maps to `not-recording` |
| `make` | Pass: plan-only, MP4 under the take, zero spend without a key, title/caption edits and missing-take error |

Real contract output summary: **tests 15, suites 0, pass 9, fail 0, cancelled 0,
skipped 6, todo 0**. The six skipped cases require the fake recorder; this run
makes no claim about those fault-injection or planner-key cases. The initial run
had one recording stop during negotiation before its two-second limit; the
repeat passed all nine real-recorder cases. The MP4 output-path assertion issue
previously present at BYOKit `fe2f806` is corrected in the tested commit: an MP4
under `<take>/out/` passes and agrees with protocol section 6.6.

Rerun `captureContract` against the built binary and update this date, BYOKit
commit and results whenever the capture protocol changes.

Back to the [README](../README.md).
