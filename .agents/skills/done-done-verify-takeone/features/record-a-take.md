# Record a take

Part of the takeone verification map. Source: `src/record.ts`, `src/session.ts`, `src/hyprland.ts`, `src/evdev.ts`, `src/taps.ts`, `src/mapping.ts`, `src/clock.ts`, `src/keyclass.ts`, `src/takes.ts`, `src/toon.ts`, `src/doctor.ts`, `src/android/`, `src/ios/`, `src/render/phone.ts`, `resources/scrcpy/`, `scripts/e2e/`. Full recipe and gotchas: `docs/verification/record-a-take.md`, `docs/recording.md`.

## How to get to it (user POV)

`takeone doctor` says what this machine can record. `takeone record` captures the whole desktop after a screen-share consent (Linux through the portal with passive input taps, macOS as a video-only preview); `takeone record --android <serial>` records a phone or emulator through scrcpy-server with touch events; `takeone record --ios-sim` records the booted iOS Simulator. `takeone stop` ends it and `takeone list` shows the take, ready for `takeone make`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe. Recording captures a real screen or device, so drive it only on dedicated fixtures: the staged scene on an empty workspace with a throwaway browser profile, or the project's own test app on an emulator. Never record a personal desktop, and never automate or bypass the consent dialog.

1. `node bin/takeone.mjs doctor`: every row the chosen source needs is `true`.
2. Desktop: follow `docs/verification/record-a-take.md` (`scripts/e2e/scene.sh start`, `scripts/e2e/drive.py`, `takeone record`, share only the scene output, `takeone stop`). Android: an emulator started for the test, `takeone record --android <emulator serial>`, drive our own fixture app, `takeone stop`.
3. Proof: the new take folder has `take.json`, the video (`screen.webm` or the H.264 stream), `frames.tsv` and `events.jsonl` (never typed characters); ffprobe reads the stream; `takeone list` shows it `complete`. Then `takeone make <id> --no-ai` and look at whole frames of the film: the camera follows the recorded clicks or taps.
4. A cancelled consent is a `consent-cancelled` error; missing evdev records video-only with `events: "none"`. Both are results to report, never to work around.
5. Capture: a still from the made film at a recorded click to $DONE_DONE_EVIDENCE_ROOT/takeone-record-after.png and the `takeone list` row to $DONE_DONE_EVIDENCE_ROOT/takeone-record-after.txt.

The drive changes no repo file: note findings in the run's report.
