---
name: verify-takeone
description: "Verify takeone — the local CLI that turns a screen capture into a polished demo MP4 (`make`, `render`, `motion`, `record`, `doctor`) — by driving its real commands and checking the real output files. Use whenever a takeone change needs proof, anything looks broken, or before claiming a render/pipeline feature works."
---

# Verify takeone

takeone is a short-lived local CLI (no server, no daemon). Verification means: build the checkout once, run the real `bin/takeone.mjs` commands the way the README teaches, and check the real artifacts they write (`out/<id>.mp4`, `camera.json`, `render.log`, `analysis/*`). A green exit code alone is not proof; the MP4 and its sidecar files are.

All paths below assume the repo root as working directory. `node bin/takeone.mjs` is the checkout-relative form; a linked install (`npm link`) exposes the same CLI as `takeone`.

## Launch

There is nothing to keep alive. Build once, then every drive is one foreground CLI invocation.

```sh
cd <takeone-checkout>
npm install        # runs prepare -> npm run build -> dist/ (skip if node_modules and dist/ already exist and are fresh)
npm run build      # rebuild after pulling; dist/ must be newer than src/
node bin/takeone.mjs --help   # readiness: exits 0 and prints the usage block
```

For the required Node version, see [Download / Install](../../../README.md#download--install); check the installed version with `node --version`. Prerequisites: `ffmpeg` and `ffprobe` on PATH. Optional: `tesseract` (only for `--screen-text` OCR), Hyprland/Wayland (only for desktop recording). Planning and rendering an existing take need none of the capture prerequisites.

In fleet/shared-machine contexts, every encode (`make`, `render`, `motion`, `scripts/synth-take.ts`) is heavy work: hold the assigned heavy render lock for the whole proof budget (normally this host's `/home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock`). A reserved release slot requires explicit coordinator assignment; do not pick another lock opportunistically. Limit the stock CLI to eight allowed CPUs with `taskset -c <eight-allowed-CPU-IDs>` when needed; inspect current affinity first, never patch the renderer to get a slot.

## Doctor

One check before driving, or whenever anything looks off:

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state"   # first: doctor creates the configured roots if missing
node bin/takeone.mjs doctor
```

Prints TOON `doctor[8]{check,ok,detail}` rows: `engine`, `engine-protocol`, `hyprland`, `evdev`, `ffmpeg`, `motion-shell`, `state-dir`, `takes-root`. The exit code is 0 only when every check passes, so read the `ok` column per check, not just the exit code: for make/render verification the gate is `ffmpeg,true` plus `takes-root,true`/`state-dir,true` — `hyprland`/`evdev`/`engine*` rows matter only for desktop recording, and `motion-shell,false` (pinned chrome-headless-shell missing) blocks only motion drives, where the fix is `takeone motion install-shell`.

## Drive

The harness is a plain shell driving the published CLI. No browser, no PTY needed. Assert on exit codes, the TOON stdout lines (`key[N]{…}`), and — for recorder errors — the structured JSON on stderr `{"error":{"code","message","hint"}}`.

Isolation rules for every drive:

- Point takes at scratch: `export TAKEONE_DIR="$PWD/tmp/verify-takes"` (default is the user's real `~/Videos/takeone`; never write there, and treat `takeone` bare-list output as the user's private data — do not read or share it).
- For record/stop drives also `export TAKEONE_STATE_DIR="$PWD/tmp/verify-state"` (default `~/.local/state/takeone`).
- Pass take directories as absolute paths so `make`/`render` never resolve through the real takes root.
- Never run `record` against a personal/shared desktop session; recording is for dedicated empty workspaces or test fixtures (see features/record-a-take.md). Never run `stop` unless this run owns the recording (it SIGINTs the pid in the state dir).

The canonical offline journey (works on any machine, zero capture, zero network, zero tokens):

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" && mkdir -p "$TAKEONE_DIR"
node scripts/synth-take.ts "$TAKEONE_DIR/synth-demo"     # scripted 44 s 1920x1080 take, drawn by ffmpeg — no screen capture
node bin/takeone.mjs make "$TAKEONE_DIR/synth-demo" --no-jev   # local-only planning + render
test -s "$TAKEONE_DIR/synth-demo/out/synth-demo.mp4"     # the proof artifact
```

`make` rewrites `analysis/*`, `camera.json`, `camera.cmd` and `out/<id>.mp4` inside the take. `render <take-dir>` re-renders from the saved analysis without calling the planner (it prints the MP4 path on stdout). See `features/` for every mapped journey, real flags and per-feature gotchas.

### verify-takeone: preserved saved-take rerender

When capture or planning is not authorized, use `features/rerender-look-tweaks.md`
with an explicitly approved saved demo take. Inventory/hash every copied input,
verify the approved source hash, and copy only into task-local scratch. Preserve
`screen.webm`, `take.json`, `analysis/beats.json`, original `analysis/decisions.jsonl`
and any supplied events/metadata byte-for-byte. Drive `node bin/takeone.mjs render
<absolute-copy-path>`; don't run `make`, which replaces analysis and decisions.
Record whether saved beats were refreshed rather than original planner output.
Name the real typing/dialog/drag intervals and their limits; boundary hints are not
semantic whole-element annotations. Verify durable input hashes again afterward.

## Evidence

Name `verify-takeone` in each new proof recipe. Follow [CONSTRAINTS.md](../../../CONSTRAINTS.md)
for the Floor command, exit meanings and test-diet exception.
`.no-mistakes.yaml` links this skill through
published `test.instructions`, trusted-default-branch-only: pre-merge agent
consumption is unproven until a stock validator actually receives that runbook.

Proof artifacts live in a named folder inside the checkout, `tmp/evidence/verify-takeone-<YYYYMMDD-HHMMSS>/`, and must survive cleanup; a user-visible change adds the dark/light, phone/desktop and per-interaction motion passes of "Review evidence (fleet standard)" below. This ignored folder keeps evidence outside the committed code branch. Per proof capture:

- The command lines run and their exit codes.
- The real output files the command produced: copy the rendered `out/<id>.mp4` into the evidence folder, plus a still extracted from it —
  `ffmpeg -y -ss <t> -i out/<id>.mp4 -frames:v 1 takeone-<feature>-<after>.png`
  (for a look/render change also extract the same timestamp from the pre-change render as `…-before.png`; stills are named `takeone-<feature>-<before|after>.png`).
- Machine-checkable output facts: `ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,codec_name -of json out/<id>.mp4 > probe.json`, and the sidecars (`camera.json`, `render.log`) that prove the pipeline ran.
- A manifest: `sha256sum * > SHA256SUMS` plus a line naming the producing commit (`git rev-parse HEAD`).

Standards: exercise the real user path (published CLI flags only — no internal setters, no test-only endpoints, no importing `dist/` internals as a library); capture the action and the resulting state, not just the final screen; verify side effects are files inside the take directory. `--no-jev` is a true offline mode (zero network calls); with a stored key `make` performs real paid calls — verification drives use `--no-jev` unless the point of the proof is the planner itself. A successful encode proves the pipeline and framing decisions ran; it does not qualify camera quality — visual quality claims need human review of the actual media. Label rendered defects `UNQUALIFIED`; missing prerequisites and incomplete validator/product proof must be reported as failure or inconclusive, never as release qualification.

## Review evidence (fleet standard)

Every user-visible change ships proof for all three kinds below in the same run's
`tmp/evidence/verify-takeone-<YYYYMMDD-HHMMSS>/` folder. takeone is a CLI with no
window and no stylesheet of its own, so a "screen" here is a rendered frame, a
"theme" is the look token set handed to `make`/`render`/`motion`, and a "form
factor" is the export geometry. Each pass names the command that produces it.

### Theme: dark and light

```sh
cp -r <planned-take> "$TAKEONE_DIR/theme-dark"; cp -r <planned-take> "$TAKEONE_DIR/theme-light"
node bin/takeone.mjs render "$TAKEONE_DIR/theme-dark"  --theme midnight   # dark
node bin/takeone.mjs render "$TAKEONE_DIR/theme-light" --theme paper      # light
ffmpeg -y -ss <t> -i "$TAKEONE_DIR/theme-dark/out/<id>.mp4"  -frames:v 1 takeone-<feature>-dark.png
ffmpeg -y -ss <t> -i "$TAKEONE_DIR/theme-light/out/<id>.mp4" -frames:v 1 takeone-<feature>-light.png
```

Extract both stills at the `<before>` timestamp so the pairs compare. Dark themes:
`midnight` (default), `aurora`, `mono`, `neon`, `terminal`. Light themes: `paper`,
`sand`, `brutalist`, `editorial` (`src/themes.ts`). One dark plus one light is the
floor; add another name from the relevant class when the change touches that token
(`display_font`, `bg_style`, `bg_pattern`, grain). `make --theme <name>` is the
one-drive equivalent. Copy the take per theme — `render` overwrites `out/<id>.mp4`
in place. **Not applicable:** motion takes reject `--theme`/`--set` by design
(`features/motion-films.md`); for a motion change the look pass is captured by
editing `storyboard.json` and rerendering, and say so rather than substituting a
placeholder capture.

### Form factor: phone and desktop

```sh
node bin/takeone.mjs make <take-dir> --no-jev --set out_w=1080 --set out_h=1920  # phone/portrait
node bin/takeone.mjs make <take-dir> --no-jev --set out_w=1920 --set out_h=1080  # desktop/wide
```

ffprobe both `out/<id>.mp4` files into `probe.json` and keep one still from each;
`make` overwrites `out/<id>.mp4`, so copy each render out of the take before the
next. Phone-shaped offline fixture when no phone recording exists:
`node scripts/synth-portrait.ts "$TAKEONE_DIR/phone-demo"` (1080×2400, taps and a
swipe); desktop fixture: `node scripts/synth-take.ts "$TAKEONE_DIR/synth-demo"`.
For a motion change the same two passes are `--device phone` and `--device laptop`
(or `browser`/`none`). **Not applicable, with the reason:** a phone-form render of a
16:9 desktop recording only re-frames the source (crop/pad) — there is no responsive
layout in takeone to miss — so that pass is stated as a re-frame, never presented as
a phone UI. A true phone pass needs a portrait take (`takeone record --android`,
or the portrait fixture above); on a host without `adb`/a dedicated device, record
the phone cell as not applicable and quote the doctor row or tool error.

### Motion recording per changed interaction

takeone renders video, so `out/<id>.mp4` is the motion recording: copy it as
`takeone-<feature>-motion.mp4` and add a contact sheet —
`ffmpeg -y -i out/<id>.mp4 -vf "fps=1/4,scale=320:-1,tile=4x3" -frames:v 1 takeone-<feature>-motion-sheet.png`.
One per changed interaction (feature 1/2: the whole take render; feature 3: the
rerender; feature 5: each motion film). When the change is an interaction the user
performs on screen — click, type, drag — drive the real states through motion so
the recording shows them happening:

```sh
node bin/takeone.mjs motion <page.html|image.png> --out "$TAKEONE_DIR/interaction" \
  --state 'edited=click #id; type #id "Ship it"; wait 300' --device phone   # one state per invocation
```

That needs the pinned headless shell (`doctor` row `motion-shell`; `takeone motion
install-shell`, network once) and a realistic scene — `scripts/e2e/scene.html`, never
a flat grey page. **Not applicable, with the reason:** a `record`-only change
(capture, Hyprland, evdev) has no offline renderer pass — its motion proof is
`takeone record` on a dedicated empty workspace or test device, and on a host where
`doctor` reports `hyprland,false` say so and drive the Android/emulator route or
report the capture path unverifiable rather than faking it.

## Cleanup

The CLI leaves no processes running (each invocation is foreground and exits). Cleanup removes only what this run created:

```sh
rm -rf "$PWD/tmp/verify-takes" "$PWD/tmp/verify-state"   # scratch takes/state this run made (never anything under ~/Videos/takeone)
```

Never delete: `tmp/evidence/` (proof evidence survives cleanup — verify after cleanup with `ls tmp/evidence/verify-takeone-*/`), committed evidence under `docs/evidence/` and `docs/quality-evidence/` (goldens), any take in the real takes root, or the portal token/state of a recording this run did not start. If this run started a recording it owns, end it with `takeone stop` before removing its scratch state dir.

## Keeping the map honest

Feature changes should update `features/` in the same change. For ongoing maintenance of this skill, follow the installed `maintain-verification-skill` skill rather than adding automation here.
