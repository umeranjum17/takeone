# takeone guide

Install, the full quickstart, planning and rendering, and development notes. Back to the [README](../README.md).

## How it works

1. **Record.** `takeone record` captures the desktop. On Linux it goes through desklink's view-only portal session and, when evdev is readable, records the pointer, clicks, wheel, key classes and focused window; on macOS (preview) it records the main display video-only through ScreenCaptureKit (see [Recording](recording.md)). Desktop frames are captured cursor-free when the engine can hide the system cursor; the renderer then draws its own vector cursor from the pointer track. Typed characters are never recorded. `takeone record --android <serial>` records a phone or emulator into the same take format instead, and `takeone record --ios-sim` records the booted iOS Simulator on macOS, video-only with no touch events (see [Recording](recording.md)). `takeone record --webcam` adds a camera that the film shows as a bubble in a corner, shrinking as the camera zooms in (see [Webcam bubble](webcam.md)).
2. **Make.** `takeone make` segments the take into beats (at most 30 per minute), finds the regions that changed, and decides each beat's shot. The AI planner decides the beats that need judgement, from zone descriptions, redacted screen words, the fallback rules' suggestion for each beat and an optional `--goal` sentence; beats with nothing to choose between are decided locally. Beats are asked in order, up to 8 per call under one shared rubric, and each call starts from the shot the previous call decided. A token preflight refuses the whole run before any call if the plan would exceed its cap.
3. **Render.** The camera path is solved on the output clock, eased through a spring and rendered with ffmpeg and libass into an H.264 MP4, silent unless `--set click_sound=0..1`, `narration=FILE` or `music=FILE` ask for sound (a tick under each click ring; a voice-over from the first frame normalised to -16 LUFS; a looping bed that ducks under the voice; one AAC stream, picture stream-copied; `music_volume=0..1` sets the bed level) (default 1920×1080; see [Output aspect and format](edit-controls.md) for orientation defaults and `--aspect`/`--resolution`/`--format` options): stage, click rings, shortcut keycaps, timed spotlight and blur regions, idle speed-up, titles and captions. Rerendering with new `--set` values never calls the planner.

## Download / Install

Install the latest packaged build from the [releases page](https://github.com/umeranjum17/takeone/releases):

```sh
npm install -g --allow-remote=all https://github.com/umeranjum17/takeone/releases/latest/download/takeone.tgz
takeone doctor
takeone --version    # prints the installed version
```

The same command works on macOS and Linux. npm 12 refuses the tarball URL without `--allow-remote=all`; npm 11 prints `npm warn Unknown cli config "--allow-remote"` for it, and npm may also print an `install-scripts` warning that mentions `prepare: npm run build`. Both warnings are harmless: the release tarball already contains `dist/`, and the install still completes.

Installing straight from git (`npm install -g github:umeranjum17/takeone`) does not work: npm 10 and 11 break the build of a git package during a global install, and npm 12 blocks git packages by default. To work on takeone itself, install from source:

Requires Node.js 22.19+ and `ffmpeg` on PATH. Optional: `tesseract` for screen-word OCR (read by default when the planner runs). Recording the desktop additionally needs Linux on Wayland with Hyprland, or macOS for the desktop preview (see [Recording](recording.md)); recording a phone needs `adb` on PATH and an attached device with USB debugging; recording the iOS Simulator needs macOS with Xcode (`xcrun simctl`), `ffprobe` on PATH, and a booted simulator; planning and rendering an existing recording take do not require those capture prerequisites. Motion setup requirements are documented in [Motion renders](motion.md).

```sh
git clone https://github.com/umeranjum17/takeone
cd takeone
npm install        # also builds dist/
npm link           # optional: puts `takeone` on PATH
takeone doctor     # report recorder requirements and motion-shell identity
```

`takeone doctor` exits 1 only when a check every capture route needs fails (ffmpeg, the state dir, the takes root). Optional rows (planner account or key, motion shell, the desktop rows (the Linux desktop route and the macOS Screen Recording grant, `screen-recording`), and xcrun for iOS Simulator) print `false` with the route that needs them in `needed_by`, and still exit 0. Android capture needs no doctor row.

Run `node bin/takeone.mjs` from the checkout, or `takeone` if the package is linked. Set `TAKEONE_DIR` to the parent of your takes; otherwise it defaults to `~/Videos/takeone`.

## Quickstart

### 1. Render a demo without recording anything

`scripts/synth-take.ts` generates a complete take: a scripted 44 s 1920×1080 UI demo (dashboard → search → list scroll → detail → slider drag → export toast) drawn entirely with ffmpeg filters, plus matching `take.json`, `frames.tsv`, and `events.jsonl`. The npm package ships the script only inside its install folder, so run these commands from a git checkout:

```sh
git clone https://github.com/umeranjum17/takeone && cd takeone
npm install
node scripts/synth-take.ts /tmp/takes/synth-demo
node bin/takeone.mjs make /tmp/takes/synth-demo
```

The polished video lands at `/tmp/takes/synth-demo/out/synth-demo.mp4`, next to the plan in `analysis/` and the camera path in `camera.json`. The run needs a signed-in AI engine (see [the AI planner](#ai-planner-key)); to rebuild it without an account, run it under `scripts/verification/recorded-engine.sh <scratch-dir>`, which answers every planner call from one recorded reply.

<a id="ai-planner-key"></a>

### 2. Let the planner decide (AI by default)

The planner is AI by default: `takeone make` asks the configured model for each beat that needs judgement and records `planner.mode: "ai"` when AI decisions are used in `take.json`. With no saved choice it follows [discovery order](#discovery-order); without an engine it stops before analysis or rendering and names sign-in commands. Beats with no choice to make still use local rules. Calls are batched in ordered chunks; see [cost and chunking](cost.md#slice-3-batched-chunks-measured-offline). One extra film call per take also picks the look; see [Plan and render](#plan-and-render).

<a id="discovery-order"></a>

#### Discovery order

This section owns the order; every other page states it by pointing here.

With nothing saved in `planner.json`, takeone offers, in order:

1. an already-signed-in BYOKit plan account,
2. an already-signed-in Claude or Codex CLI account,
3. a stored key.

Without one, normal `takeone make` exits 3 before writing analysis or a film. Sign in with `claude` or `codex login` (or `opencode auth login` for an OpenCode account). An explicit saved choice wins over discovery.

An account is offered only when it can serve. The kit must report it ready, and a Claude CLI that is signed in with an API key, Bedrock or Vertex — a real, working sign-in that bills per call and cannot answer the subscription ask — is passed over for the stored key, with the reason said out loud rather than swallowed. A discovered plan account takes the first model its own live list offers; takeone names no model of its own. A saved choice is never switched: takeone never moves provider on a limit, a refusal, an error or a missing key.

Store your key with `takeone key set`, which reads one key line from piped stdin and records the provider choice. For example, in Bash, this hidden prompt keeps it out of argv and shell history:

```bash
read -rsp 'Planner API key: ' planner_key; printf '\n'
printf '%s' "$planner_key" | takeone key set
unset planner_key
```

With no flags that stores a Jev key (the default when you pick nothing). Pick another provider with flags:

```bash
printf '%s' "$planner_key" | takeone key set --backend openai --model gpt-6.1-sol
printf '%s' "$planner_key" | takeone key set --backend anthropic --model claude-opus-5-5
printf '%s' "$planner_key" | takeone key set --backend opencode-go --model opencode-go/muse-spark-1.3-contributor
printf '%s' "$planner_key" | takeone key set --backend jev --via openrouter
```

When the decider BYOKit builds from that config reads images (the config's own `supportsImages` capability, openai and anthropic only; BYOKit refuses images for any other backend), the planner also gets one small keyframe thumbnail at each beat's action and one at its result (512 px long side, JPEG), with every zone outlined and labelled. The whole screen image is blurred past reading, text zones included and whether or not OCR read any text there; the zone notes carry the redacted words. The score judge's frames are blurred the same way. A text-only decider gets the zone notes alone. In capture mode thumbnails are sent only with screen text opted in. takeone keeps no model list of its own. Cost per minute is in [cost.md](cost.md#slice-3-batched-chunks-measured-offline).

The choice is stored as a BYOKit decide config in `${XDG_CONFIG_HOME:-$HOME/.config}/takeone/planner.json` (`backend`, `auth`, `model`, `via`, `supportsImages`), validated on load. With no saved choice it follows [discovery order](#discovery-order). An explicit choice always wins, and takeone never switches provider on a limit, an error or a missing key — a provider that cannot serve the run stops before rendering with exit 3 and the three choices (wait and rerun, or pick another provider yourself). `takeone doctor` names the account or key it found and the planner in use; with neither it reports that planning is unavailable.

Subscription sign-ins need no key; supported account selections and their behavior are documented in the [plan-and-render guide](verification/plan-and-render-take.md#live-planner-run-on-a-picked-account). A saved `planner.json` account that is not signed in stops the run with a message, and so does a discovered account whose CLI refuses the ask: takeone names the account's sign-in method and the check to run, rather than falling back per step to local rules. Only a reply the model got wrong falls back per beat.

Already have `pi` installed and signed in? Plan with it and store no key of your own. Write that same file by hand (there is no `key set` flag for a route with no key of TakeOne's own):

```json
{"backend":"pi","bin":"/absolute/path/to/pi","model":"deepseek/deepseek-flash"}
```

`bin` is your own installed pi (`command -v pi` prints it; give TakeOne the absolute path) and `model` is any model that pi can already reach. Each planner call then runs that pi once in JSON mode with no tools, extensions, skills, prompt templates, context files or session, so pi answers with the provider sign-in it already has: TakeOne never reads, copies or stores pi's key or settings. TakeOne keeps no model list, so ask pi which models it can reach with `pi auth check --model <model> --json` (`"status":"ready"` means yes); `takeone doctor` shows `AI planner: found and using pi (<model>)` when that check passes. A pi that is missing from `bin` or not signed in for that model stops the run with exit 3 and that exact check to run, rather than quietly falling back to rules or switching provider. pi reports tokens but no price, so `take.json` records the token counts and `planner.usd: null`; see [cost.md](cost.md).

Each backend's key lives under service `takeone` in the OS keyring through `@byokit/secrets` (macOS Keychain or Linux Secret Service; Linux needs `/usr/bin/secret-tool` and an unlocked session), under the backend's own secret name (`jev` for the default). If the keyring is absent, unsupported, or unavailable when used, BYOKit's sealed file at `${XDG_CONFIG_HOME:-$HOME/.config}/takeone/secrets.json` is used when a passphrase is supplied on an open fd >= 3. Set `TAKEONE_SECRETS_PASSPHRASE_FD` to that fd number for each command that reads or writes the store. Supply the same passphrase bytes each time; the passphrase is never saved. For an isolated install (CI, a throwaway test HOME), set `TAKEONE_NO_KEYRING=1` (only `1`, `true` or `yes` enable it) to skip the OS keyring entirely — keys then come only from the sealed file, and an inherited `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` cannot surface a host keyring key. TakeOne never reads a key from an environment variable. For example:

```bash
read -rsp 'Store passphrase: ' store_passphrase; printf '\n'
read -rsp 'Jev API key: ' jev_key; printf '\n'
printf '%s' "$jev_key" | TAKEONE_SECRETS_PASSPHRASE_FD=3 takeone key set 3< <(printf '%s' "$store_passphrase")
TAKEONE_SECRETS_PASSPHRASE_FD=3 takeone make <id> 3< <(printf '%s' "$store_passphrase")
unset jev_key store_passphrase
```

`capture make --screen-text` opts into reading redacted screen words; capture otherwise keeps OCR off. `capture make --planner-key-fd N` uses only the supplied fd key, preserving capture's host-owned credential contract; without it, capture planning stays local even when a stored key is available. `capture make --planner-account` is the opt-in for a host whose only AI access is the user's signed-in account: it resolves the user's own planner exactly as `takeone make` does (a signed-in Claude or Codex CLI account, a signed-in BYOKit subscription, or a stored key), so the host, not takeone, decides whether that subscription may be spent by passing the flag. With nothing able to serve the run it stops with `planner-unavailable` and the cause (no signed-in account or stored key, or a secret store that cannot be read) instead of quietly planning with local rules; nothing renders on that stop. `--planner-account` conflicts with `--no-planner` and with `--planner-key-fd`, both usage errors (exit 2). Planner stops carry their own capture error codes: `planner-unavailable` when the provider cannot serve the run (wait for the limit to reset and rerun, or rerun with `--no-planner`), and `planner-config` when planner.json is invalid or names an account sign-in, which a supplied key cannot drive (fix planner.json); every other failure keeps the `render-failed` envelope. `capture hello` reports key availability through the same stored-key read `make` uses, so it also migrates a legacy credential. A legacy plaintext key from `~/.config/takeone/env` is moved into an empty `jev` slot on the first read (by make, doctor or `capture hello`), verified, then its old line (or key-only file) is removed. This legacy path does not follow `XDG_CONFIG_HOME`. Unrelated settings are preserved; an existing stored key is never overwritten by migration, and a different legacy key is left untouched. Interrupted cleanup resumes when the stored and legacy keys match.

Re-run `make` once an engine is signed in. Add `--goal "what the demo shows"` for sharper key moments, `--style calm` for the film's manner, and `--replan` to ask the planner again instead of reusing saved answers.

### 3. Record your own take (Linux on Wayland with Hyprland, or macOS desktop preview)

```sh
takeone record                # grant the screen-share consent; share only the output you are demoing
# ...demonstrate your app...
takeone stop
takeone                       # list takes, newest first
takeone make <id> --goal "Creating a task and moving it across a project board"
```

`takeone record` needs a person to click Share in the compositor's screen-share dialog (Linux) or to approve Screen Recording once (macOS), so it cannot run unattended. If no one is at the desktop, use the [headless demo scene](headless-scene.md) instead (from a git checkout): it produces a take without opening a display, portal or input device.

### 3b. Record a phone instead (Android, hand-driven on the device)

```sh
takeone record --android <serial>   # USB phone or emulator; needs adb on PATH with USB debugging enabled
# ...demonstrate the app with fingers on the phone (or the emulator-window mouse)...
takeone stop
takeone make <id> --goal "Searching and checking out in the app"
```

The phone take uses the same directory format (`take.json`, `screen.webm`,
`frames.tsv`, `events.jsonl`). Android recordings carry the encoder's timestamps,
including still holds, and render with a graphite handset frame. The recorder
prints `recording:` once video is flowing; start demonstrating after that message.
Portrait output defaults to 1080×1920. `--touch-offset-ms N` calibrates touch timing.
To plan the same take for a wide export, set both output dimensions:

```sh
takeone make <id> --set out_w=1920 --set out_h=1080
```

For a reproducible real recording, the offline Tidewater Android fixture reuses
`scripts/e2e/scene.html`. It needs an Android SDK with API/build-tools 35, a JDK,
and a dedicated 1080×2400 emulator at density 420. It has no accounts or network
permission. Install it only on a test emulator. The fixture scripts are not in the
npm package, so run these steps from a git checkout:

```sh
git clone https://github.com/umeranjum17/takeone && cd takeone
npm install
```

Create the test emulator once with the SDK's `sdkmanager` and `avdmanager`. The
`pixel_6` profile gives the 1080×2400 screen at density 420 that `record.ts` requires:

```sh
sdkmanager "system-images;android-35;google_apis;x86_64" "platforms;android-35" "build-tools;35.0.0"
avdmanager create avd -n takeone-tidewater -k "system-images;android-35;google_apis;x86_64" -d pixel_6
emulator -avd takeone-tidewater
```

`record.ts` throws unless `adb -s emulator-PORT shell wm size` reads `1080x2400` and `adb -s emulator-PORT shell wm density` reports 420.

On a fresh device, Android shows a "Viewing full screen" sheet over the app until "Got it" is tapped, and it blocks the taps. Before the app's first launch, run this once (`record.ts` runs it too and stops if it does not read back `confirmed`; takeone never changes device settings itself):

```sh
adb -s emulator-PORT shell settings put secure immersive_mode_confirmations confirmed
adb -s emulator-PORT shell settings get secure immersive_mode_confirmations   # prints confirmed
```

```sh
scripts/e2e/android/build.sh
adb -s emulator-PORT root
adb -s emulator-PORT install --no-incremental -r tmp/android-fixture/tidewater.apk
node scripts/e2e/android/record.ts emulator-PORT "$PWD/tmp/android-takes"
# Prints the real take path; four kernel taps create a high-priority launch brief.
take_path=/absolute/path/to/take
take_id=$(basename "$take_path")
mkdir -p tmp/android-renders
takeone make "$take_path" --set idle_speed=1
cp "$take_path/out/$take_id.mp4" tmp/android-renders/portrait.mp4
takeone make "$take_path" --set idle_speed=1 --set out_w=1920 --set out_h=1080
cp "$take_path/out/$take_id.mp4" tmp/android-renders/wide.mp4
```

The film starts after a leading trim of the raw take (about 2 s, `source_trim_start_seconds` in the evidence manifest), so it can be shorter than the take it came from, when the take has a leading trim: the Tidewater take runs about 19.8 s and its film about 17.7 s.

Committed real-device evidence for this flow is in
[`docs/evidence/android-recording/`](evidence/android-recording/), with capture provenance,
render commands, dimensions and SHA-256 hashes in its
[`manifest.json`](evidence/android-recording/manifest.json). It includes the raw
Tidewater recording, portrait and wide renders, a contact sheet
for each render, and a side-by-side comparison of the first ten seconds.
The recording was made on a dedicated API 35 emulator using the offline
Tidewater fixture. The committed wide render reflects the caption placement
change recorded in the manifest; the portrait render and raw comparison use the
same source recording. Review the actual media files when assessing output quality.

`scripts/synth-portrait.ts` remains an offline colour-pattern timing fixture.
It is not an Android app recording or product demo.

### 3c. Record the iOS Simulator instead (macOS, Xcode with the Simulator)

If you have no booted Simulator yet, create and boot one with `xcrun simctl`:

```sh
xcrun simctl list devicetypes      # pick a device type identifier
xcrun simctl list runtimes         # pick an iOS runtime identifier
xcrun simctl create takeone-demo com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-3
xcrun simctl boot <UUID>           # UUID of the new device from: xcrun simctl list devices
xcrun simctl bootstatus <UUID> -b  # waits until the device is up
xcrun simctl list devices booted   # the booted device's UUID is the --ios-udid value
```

```sh
takeone record --ios-sim   # needs a booted simulator; macOS only
takeone record --ios-sim --ios-udid <UUID>   # isolate capture to this booted device
# ...drive the app in the Simulator by hand...
takeone stop
takeone make <id> --goal "Onboarding and first export in the app"
takeone render ~/Videos/takeone/<id> --aspect landscape   # wide 1920×1080 film; make writes portrait for a phone take
```

To drive a demo app instead of your own, the [iOS fixture recipe](../scripts/e2e/ios/README.md) builds, installs and launches the Tidewater app on a Simulator you created.

Video-only: no `events.jsonl` is written, so the camera plans from screen changes alone. Localized changes form `change` beats with result zones; animation frames group into one subject, and unchanged footage stays idle. Observed result holds retain their duration through shared pacing. These beats use the shared AI attention policy, camera path and renderer, with the same beat and token caps. A changed subject is recentered after it appears, without inventing touch events.

### 4. Tweak the look and rerender

Rerender without planning again:

```sh
takeone render ~/Videos/takeone/<id> --set background=#0B1220 --set idle_speed=3
```

To see a look change first, render a fast preview instead of the full film:

```sh
takeone render ~/Videos/takeone/<id> --preview --set background=#0B1220
```

`--preview` writes `out/<id>-preview.mp4`: the same camera path, the same framing and the
same timestamps as the full render, at about 480p and 30 fps with no motion blur. It warps
from a 1080p proxy of the recording, made once beside the take and reused by every later
preview, so a theme or `--set` change can be seen in a fraction of the full render's time.
The full render is unchanged by it: `camera.json` is the same file, byte for byte.

Every preview prints where its time went, for example
`preview timing: camera solve 0.4s (reused from the last solve), proxy reused (cached), render 14.1s, total 14.5s`.
The camera solve runs at full resolution (that is what keeps the framing identical) and is
the slow part of a cold preview. Its result is kept beside the take (`solve-cache.json`) and
reused by every later preview or render until the take, the look or the camera code changes
(the line then says `reused from the last solve`). The proxy is the other cold cost: it is built on the first preview of a take
whose recording is taller than 1080 px (the line says `built now`), then reused. A
recording at 1080p or below needs no proxy.

### 5. Score the film and let it improve

Pass a target score to render, judge and improve in rounds:

```sh
takeone make <id> --target-score 9 --max-rounds 4
```

The loop extracts single frames, measures them, asks the configured judge for a score against a written rubric, fixes the weakest build inputs and re-renders. It stops at the target, when a round gains nothing, or at `--max-rounds`. The result is `out/score.json` with every round's score and item breakdown, the frame paths, and an explicit below-target list when the bar is not reached. See [the score loop](score-loop.md) and its [call and render cost](score-loop.md#cost-and-time).

### 6. Directions, pick and polish

Render two or three distinct cuts of one take, pick one, and let an independent judge refine it to 9/10:

```sh
takeone directions <id> --count 3 --board .sign-off/decisions.json
takeone pick <id> b
takeone polish <id> --max-rounds 5 --feedback "hold the result longer"
```

Each direction is a theme, a pacing and a camera motion over the same plan; each is a real render the judge scores once.
Polish keeps the picked look, reads the owner's notes every round (typed, or left on the board), rejects a round that
misses one, and stops at 9/10, after two rounds without a better score, or at five refinements. With `--board` every
option and round is a playable card on the sign-off board. See [directions, pick and polish](directions.md).

## Motion design from screens

Use `takeone motion` to create a film from images, HTML, a URL or an existing take directory without recording:

```sh
takeone motion design.png --out takes/launch --theme editorial --title "Ship your next idea" --device browser
```

`takeone motion --storyboard template.json --data rows.csv` renders one film per spreadsheet row, filling the template's `{{column}}` fields from each row. See [Motion renders](motion.md) for shell setup, capture states, pattern options, batches and the storyboard contract.

## Plan and render

```sh
node bin/takeone.mjs make <id> [--goal "sentence"] [--style "word"] [--no-screen-text] [--replan] [--max-tokens N] [--theme midnight|paper|aurora|mono|neon|brutalist|sand|terminal|editorial] [--set key=value]
node bin/takeone.mjs render /path/to/take [--theme midnight|paper|aurora|mono|neon|brutalist|sand|terminal|editorial] [--set fps=24] [--aspect landscape|portrait|square|4:5] [--resolution 4k] [--format mp4|gif|webm|prores4444] [--preview]
```

`<id>` can also be an absolute take-directory path. `make` writes `analysis/regions.json`, `analysis/ui-boxes.json`, `analysis/actions.json`, renderer-format `analysis/beats.json` (video-relative seconds), one decision per line in `analysis/decisions.jsonl`, and the per-beat camera choices in `analysis/plan.json` ([plan and render](verification/plan-and-render-take.md)); Planner answers are cached separately in `analysis/planner-cache.jsonl`. It updates `take.json` with usage and render metadata, recording `trim_end` for a trim you set yourself (clamped to the recording) and leaving it unset for the trim `record` itself wrote, which it marks `auto_trim` next to the recorded capture length; any other trim is yours and is exported as given. A take recorded before that marker existed is read as record's whenever its unmarked trim end lands within one 100 ms analysis frame of the video's end, whichever way the timeline rounding falls. One case stays ambiguous: a take whose edited end is exactly equal to the recorded length still reads as automatic while the marker is left in place. It then writes `camera.json`, `camera.cmd`, and `out/<id>.mp4`. Zone data retains individual nearby perception boxes even when focus candidates are deduplicated. A local UI-surface pass also finds static cards, panels and dialogs in the existing quarter-size grey decode, so unchanged surfaces can frame clicks with empty change regions. It analyzes at most one reference per occupied second measured from the trim start, choosing actual decoded frames to prioritize uncovered action and shot times across adjacent seconds. Each reference retains at most 24 boxes. `ui-boxes.json` records reference count, elapsed analysis time per video minute, zero model calls and zero API cost. References more than half a second away, or across a cut/redraw, are excluded. This is a conservative flat-surface detector: low-contrast boundaries, gradients and image-filled cards may be missed. Zoomed holds include enclosing context, align crop edges around neighboring boxes, and widen when needed; known UI boxes are kept whole or at least 90% outside the crop. On a page too dense for any such crop, the hold instead takes the best-centred push-in whose edges the text guard reads clean, so no word is cut even where a box is. A scroll that settles at least `min_shot` before the next shot gets a push-in on what it settled on (the change regions after it, else its largest result zone, when that is under half the screen). When a shot with no gesture and a click, typing, drag or shortcut shot fall under `min_shot` apart, the gesture keeps its shot. Re-running `make` can reuse cached responses. A trim must overlap the video; only that overlap is planned. Beats are capped at 30 per minute, which may merge idle gaps.

Drag framing widens the view to keep the dragged element and cursor visible, retaining the whole source when complete object bounds are unknown. See [drag visibility and boundary handling](quality.md#drag-framing) for the path, trim and coverage-check contracts.

With a [configured planner credential](#ai-planner-key) or a signed-in Claude or Codex CLI account, the planner receives zone descriptions, redacted screen words, and an optional `--goal` sentence. Screen words (up to 12 redacted OCR words per zone plus the window title) are read by default when the planner runs; `--no-screen-text` opts out, and the redaction is unchanged: each OCR token and each whitespace-delimited window-title word is sent only if it has 2–15 ASCII letters; every other token is `[redacted]`. OCR fragments are not joined. Without an engine, or when the secret store cannot be read, normal `make` stops before writing analysis or a film with exit 3 and one sign-in message. `takeone make` has no offline option; malformed model replies can still fall back per beat pending removal. A provider that cannot serve the run (rate limit, auth refusal, timeout) also stops before rendering with exit 3. The preflight refuses planned requests above `--max-tokens` (default 40,000 per take minute); One film call per take runs first and picks the theme, pace (`--style calm` or `brisk` steers it), opening hold, ending beat and camera style. A `--set` key, an explicit `--theme` or a theme already saved in `take.json` always wins over the film's choice; the film's look is saved in `take.json` so `takeone render` reproduces it. The film ends on its chosen beat only when the take has no trim end yet, so a trim the recorder or you set always wins. A take too long for one film request is split, never trimmed: the film is planned in ordered chunks under the same 4,000-token cap, the first chunk picks the theme, pace, opening and camera style, the last picks the ending, every chunk asks the title or captions of its own beats when the planner returns text (a text-less planner's middle chunk asks the film-wide questions instead), and each chunk after the first is told what the chunk before it planned, in a short summary of those beats. The chunk plans join into one film; `make` logs `film: this take is over one request's cap, so the film is planned in N chunks` when it splits one. The film keeps the base look only when a single beat is over the cap on its own. The film call also writes an AI title and per-beat captions, each with the seconds it stays on screen (up to 8, and never under the words' reading time of 0.3 s a word plus 0.8 s), when the planner returns text: the Anthropic, OpenAI, Codex, pi and OpenCode Go planners do; the default Jev planner is not asked, so those takes have no title or captions. A `title` or `captions` already in `take.json` (set with `capture make --title` or `--captions`) wins field by field: a take's own title leaves the film's captions, and its own captions leave the film's title, while an empty `title`, or `captions: []`, keeps the film's text out of a take that would otherwise inherit it. Window titles are still not part of the film call.

### Render an existing take

For an existing planned recording take, render reads `screen.webm`, `take.json` (at least `width` and `height` in source pixels), `analysis/beats.json` as a beat array, and `analysis/decisions.jsonl` as one decision per line; an optional `analysis/plan.json` applies the user's edits over those decisions and over the film's look (per-beat shot, idle, follow, focus, tightness and key moment; film theme, pace, opening, camera style, ending and title; a field takeone does not plan is refused); an edit the take cannot honour stops with a clear error naming the beat instead of rendering a different film. Each plan entry carries the beat's place (`id`) and a stable `key` hashed from what the beat shows, so an edit follows its beat when a re-cut renumbers the film, an edit whose beat the cut removed is dropped and named under `dropped` in that file, and an entry carrying another beat's key is refused rather than applied to the wrong beat. Each beat needs a matching decision whose A (and optional B) names refer to that beat's zones. For an existing recording take, `events.jsonl` may be omitted only when `take.json` has `"events": "none"`; an empty event file is also valid. Motion takes use the [motion rerender contract](motion.md) instead.

For a headless scene take, the safe-area check judges the text each frame paints: a titled 16:9 take keeps its screen card inside the inset, so the default 1920×1080 render passes even with camera push-ins. An untitled take fills the frame, and a push-in then paints the board's own text inside the outer 5%, so pass `--set max_upscale=0.5` to `make` and `render` for that take; without it the render stops with exit 1, naming the first text box that crosses the 5% inset. The film is written to `out/<id>.mp4`, where `<id>` is the take's `id` in `take.json`, not the directory name; the scene sets `id` to `headless-demo`, so its film is `out/headless-demo.mp4`.

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`; rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`, `render.log` (including libass font selection), and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default 1920×1080 at 60 fps; see [Output aspect and format](edit-controls.md) for orientation defaults and `--aspect`/`--resolution`/`--format` options). Render splits the film into up to four time segments, one per four CPU cores and per 5 GiB of available memory, averaging at least 2 s each, renders them in parallel and joins them without re-encoding; the frames match a single pass. `TAKEONE_RENDER_SEGMENTS=<n>` sets the count, and `1` renders in one pass. `TAKEONE_RENDER_THREADS=<n>` caps the ffmpeg thread count for the render and for the GIF, WebM and ProRes exports (default the lesser of eight and the available cores); use it to hold a render to a fixed count on a shared machine. `--set quality=draft|standard|master` selects CRF 23 (draft) or 12 (standard and master); `--set preset=...` independently controls encoder speed. Output uses limited-range bt709 colour conversion and tags. See [native-pixel sharpness qualification](sharpness.md) for the camera sampler, output measurements and capture limitations. Standard and master use animation encoder tuning; master encodes yuv444p and requires a player supporting H.264 High 4:4:4 Predictive. Draft and standard use compatible yuv420p. Zoom defaults to `max_upscale=1.0`; use `--set max_upscale=1.5` only to opt into enlarging source pixels. Optional manual `zooms` in `take.json` (`t0`/`t1` spans with a source-pixel `bbox` and a 0–3 `level`) are validated at render: malformed entries, boxes outside the source, spans shorter than a 0.5 s hold, or overlapping intervals fail with the field and index, and a zoom whose requested depth exceeds the upscale ceiling prints the requested and achieved depths. A manual zoom widens to take in a change that paints partly inside its box, such as a popup the click opened; content a scroll repaints (until `dwell` after it stops) and changes more than a quarter of the screen's shorter side from the last pointed gesture do not widen it. Whole-screen shots of non-16:9 sources are centred on the stage background rather than cropped; zooming can crop the screen. If `take.json` omits `id`, the directory name is used; if it omits `trim_end`, the export ends one `outro_s` after the final action, settled cut, or detected result on the output clock, so a result that lands after the beat's last action still holds the whole stage for the whole outro; that end includes the terminal fade and is bounded by the recording length (`duration`), which `make` records. Resting pointers do not extend it, and an explicit `trim_end` is exported as given, clamped to the recording — including an end that lands exactly on the video's own end or past it; which trims count as explicit is decided by [`make`](#plan-and-render). Exports hold the whole stage for `establish_s` (default 1.6 s) before moving, cut to as little as half of it when the first click comes too early for the push-in to land on it, ease back to the whole stage before the final `outro_s` (default 1.6 s), and fade. Opening and closing holds are not idle-squeezed. The outro gives way to the last action: the pull-back starts only once the last shot has landed and held for `min_shot`, so the closing hold is shorter when the action is late, and when the take ends before the pull-back has room, the film ends on that shot. A clip with no shot and no room for its bookends stays wide. Set `outro_s=0` to keep the camera on its last shot and drop the closing hold and padding; the export still ends on that last purposeful activity instead of the recorder's trailing inactivity. A take with no title of its own and none from the film is rendered untitled; its captions keep their recorded times.

`--set motion_blur=0..1` controls camera blur (default 1). Fast pans and zooms use a centred 180° shutter at full strength, with enough camera samples to keep neighbouring samples within 2 output pixels. Slow moves and holds stay sharp; captions remain sharp throughout. Source images are held fixed during each exposure, so changing UI does not smear between frames. `motion_blur=0` disables sampling. Render writes the sampling count, peak spacing and estimated warp work to `motion-blur.json`.

## End-to-end take with a staged scene

To produce a scripted board take without a desktop, use the [headless demo-scene guide](headless-scene.md). It needs a git checkout, because its scripts (`scripts/headless-scene.mjs`, `scripts/install-headless-shell.mjs`) are not in the npm package; see [From source](../README.md#from-source).

`scripts/e2e` records a harmless real take without touching your own apps. It stages and drives the board shown in the [README](../README.md):

- `scene.sh start PROFILE_DIR [WORKSPACE]` opens `scene.html` fullscreen on an empty Hyprland workspace (default 9). The page is a fictional project board with dummy content, run in a throwaway Chromium profile.
- `drive.py serve FIFO` creates a uinput virtual mouse and keyboard (group `input`), so the recorder's evdev taps see real kernel events.
- `echo scene > FIFO` plays ~60 s of clicks, typing, a dropdown, a drag, scrolling and a menu against the scene's fixed geometry.

```sh
python3 scripts/e2e/drive.py serve /tmp/drive.fifo &      # before recording: taps enumerate devices at start
scripts/e2e/scene.sh start ~/lab/scene-profile
takeone record &                                         # share only the output that shows the scene
echo scene > /tmp/drive.fifo; sleep 65; takeone stop
scripts/e2e/scene.sh stop ~/lab/scene-profile 1          # return to your workspace
takeone make <id> --goal "Creating a task and moving it across a project board"
```

The README hero and how-it-works images come from one headless take: the `scripts/e2e/scene.html` board captured cursor-free by `scripts/headless-scene.mjs` (see the [headless demo-scene guide](headless-scene.md)), planned by the recorded engine (`make --set fps=60` under `scripts/verification/recorded-engine.sh`) and rendered with `--theme sand` for light mode and `--theme aurora` for dark mode. Each hero clip is the render alone: it opens with the camera pushed in on the New task dialog and loops back to it, at double speed, 24 fps, 960 px wide, as animated WebP. The plan step's green box is the zone the plan chose for that beat.

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
