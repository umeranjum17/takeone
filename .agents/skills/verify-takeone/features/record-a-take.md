# Record a take (`record` / `stop` / list)

README Quickstart 3/3b/3c: capture a take for later `make`. Desktop recording captures the whole screen through desklink's view-only portal session plus passive input taps; `--android <serial>` records a phone or emulator via scrcpy-server; `--ios-sim` records the booted iOS Simulator video-only. Recording ends with `takeone stop`.

## Sub-features

- Desktop record (`takeone record`, Linux/Wayland/Hyprland): VP9 `screen.webm`, `frames.tsv`, `events.jsonl` (pointer/clicks/wheel/key classes/window; typed characters are never recorded), portal consent with a persisted single-use restore token.
- Cursor-free desktop capture: the session opens with `cursor:"hidden"` when the source advertises it, keeping Desklink's `session.cursor` pointer track and marking the take `cursor_free: true`; a refused hidden falls back to embedded with one plain message and `cursor_free: false`. See [vector-cursor.md](vector-cursor.md) for the X11 nuance and the refusal proxy.
- Android record (`record --android <serial>`): H.264 via vendored scrcpy-server + `getevent` touch; `--touch-offset-ms N` calibrates timing; needs `adb` and USB debugging.
- iOS Simulator record (`record --ios-sim`, macOS): H.264 via `xcrun simctl io booted recordVideo`, video-only (`take.json` carries `"events": "none"`).
- Stop (`takeone stop`, SIGINT to the pid in the state dir) and listing (`takeone` bare / `takeone list`, TOON `takes[N]{id,status,duration_s,frames,pointer}`).

## How to get to it (user POV)

The user grants a screen-share consent for the output being demoed (or attaches a test phone / boots a test simulator), demonstrates the app by hand, then stops and runs `make` on the new take id. The recorder prints `recording:` once video is flowing.

## Driving it with the takeone CLI

Agent drives are restricted: recording captures a real screen or device, so only record dedicated fixtures — never a personal/shared desktop, and on phones only the project's own test app on a test device/emulator. The repo's scripted path is the staged scene (fictional Tidewater board, throwaway Chromium profile, empty Hyprland workspace):

```sh
export TAKEONE_STATE_DIR="$PWD/tmp/verify-state" TAKEONE_DIR="$PWD/tmp/verify-takes"
scripts/e2e/scene.sh start ~/lab/scene-profile        # empty workspace, throwaway profile
python3 scripts/e2e/drive.py serve /tmp/drive.fifo &  # virtual uinput mouse/keyboard
node bin/takeone.mjs record &                         # consent dialog -> share only the scene output
echo scene > /tmp/drive.fifo; sleep 65; node bin/takeone.mjs stop
scripts/e2e/scene.sh stop ~/lab/scene-profile 1
node bin/takeone.mjs make "$TAKEONE_DIR/<id>" --about "Creating a task and moving it across a project board"
```

Proving end state: a new take directory with `take.json`, `screen.webm`, `frames.tsv`, `events.jsonl`; `ffprobe` confirms the stream; `takeone list` shows it `complete`. A cancelled consent dialog is a `consent-cancelled` structured error and is never retried or bypassed.

## Gotchas

- `stop`/`list` read the state dir from `TAKEONE_STATE_DIR` env, not from `record --state-dir` — export it or stop will miss the pid file.
- Human-driven only on real desktops: a portal consent dialog appears whenever silent restore is unavailable; never automate or bypass consent, and never point recording at a personal session (privacy boundary).
- Missing/unreadable evdev makes recording continue video-only (`events: "none"`); unmatched monitor disables pointer mapping — both degrade planning, they don't fail the take.
- Android takes carry encoder timestamps including still holds; portrait output defaults to 1080×1920 unless `--set out_w=1920 --set out_h=1080` at make time.
- `scripts/e2e/uiboxes-record.sh` (Xvfb + Chromium fixture) is the headless scripted variant; it is heavy work — hold the shared heavy lock in fleet contexts.
- `TAKEONE_CURSOR` (`hidden`/`embedded`) overrides the cursor policy; on an X11 source `embedded` is a no-op (the engine never bakes a cursor there), so a `capture record --source x11:*` take is cursor-free regardless.
