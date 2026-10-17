# Verification operations through done-done

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

For the required Node version, see [Download / Install](../guide.md#download--install); check the installed version with `node --version`. Prerequisites: `ffmpeg` and `ffprobe` on PATH. Optional: `tesseract` (only for `--screen-text` OCR), Hyprland/Wayland (only for desktop recording). Planning and rendering an existing take need none of the capture prerequisites.

On a shared machine, every encode (`make`, `render`, `motion`, `scripts/synth-take.ts`) is heavy work: agree on one heavy-render lock for the machine and hold it for the whole proof budget instead of picking a per-command lock. Limit the stock CLI to your allowed CPUs with `taskset -c <allowed-CPU-IDs>` when needed; inspect current affinity first, never patch the renderer to get a slot.

## Doctor

One check before driving, or whenever anything looks off:

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state"   # first: doctor creates the configured roots if missing
node bin/takeone.mjs doctor
```

Prints TOON `doctor[N]{check,ok,needed_by,detail}` rows: `engine`, `engine-protocol`, `jev-key`, `ffmpeg`, `motion-shell`, `state-dir`, `takes-root`, plus `hyprland` and `evdev` on Linux only and `xcrun` (iOS Simulator) on macOS only. The exit code is 1 only when a check with `needed_by` `all` fails (ffmpeg, state-dir, takes-root), so read the `ok` column per check, not just the exit code: for make/render verification the gate is `ffmpeg,true` plus `takes-root,true`/`state-dir,true` — `hyprland`/`evdev`/`engine*` rows matter only for desktop recording, `jev-key,false` means planned films fall back to `--no-jev` (fix: `takeone key set` from stdin), and `motion-shell,false` (pinned chrome-headless-shell missing) blocks only motion drives, where the fix is `takeone motion install-shell`.

## Drive

The harness is a plain shell driving the published CLI. No browser, no PTY needed. Assert on exit codes, the TOON stdout lines (`key[N]{…}`), and — for recorder errors — the structured JSON on stderr `{"error":{"code","message","hint"}}`.

Isolation rules for every drive:

- Point takes at scratch: `export TAKEONE_DIR="$PWD/tmp/verify-takes"` (default is the user's real `~/Videos/takeone`; never write there, and treat `takeone` bare-list output as the user's private data — do not read or share it).
- For record/stop drives also `export TAKEONE_STATE_DIR="$PWD/tmp/verify-state"` (default `~/.local/state/takeone`).
- Pass take directories as absolute paths so `make`/`render` never resolve through the real takes root.
- Never run `record` against a personal/shared desktop session; recording is for dedicated empty workspaces or test fixtures (see docs/verification/record-a-take.md). Never run `stop` unless this run owns the recording (it SIGINTs the pid in the state dir).

The canonical offline journey (works on any machine, zero capture, zero network, zero tokens):

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" && mkdir -p "$TAKEONE_DIR"
node scripts/synth-take.ts "$TAKEONE_DIR/synth-demo"     # scripted 44 s 1920x1080 take, drawn by ffmpeg — no screen capture
node bin/takeone.mjs make "$TAKEONE_DIR/synth-demo" --no-jev   # local-only planning + render
test -s "$TAKEONE_DIR/synth-demo/out/synth-demo.mp4"     # the proof artifact
```

`make` rewrites `analysis/*`, `camera.json`, `camera.cmd` and `out/<id>.mp4` inside the take. `render <take-dir>` re-renders from the saved analysis without calling the planner (it prints the MP4 path on stdout). See `docs/verification/` for every mapped journey, real flags and per-feature gotchas.

### done-done: preserved saved-take rerender

When capture or planning is not authorized, use `docs/verification/rerender-look-tweaks.md`
with an explicitly approved saved demo take. Inventory/hash every copied input,
verify the approved source hash, and copy only into task-local scratch. Preserve
`screen.webm`, `take.json`, `analysis/beats.json`, original `analysis/decisions.jsonl`
and any supplied events/metadata byte-for-byte. Drive `node bin/takeone.mjs render
<absolute-copy-path>`; don't run `make`, which replaces analysis and decisions.
Record whether saved beats were refreshed rather than original planner output.
Name the real typing/dialog/drag intervals and their limits; boundary hints are not
semantic whole-element annotations. Verify durable input hashes again afterward.

## Evidence

Name `done-done` and the project journey in each new proof recipe. Follow [CONSTRAINTS.md](../../CONSTRAINTS.md)
for the Floor command, exit meanings and test-diet exception.
`.no-mistakes.yaml` links the project journeys through
published `test.instructions`, trusted-default-branch-only: pre-merge agent
consumption is unproven until a stock validator actually receives that runbook.

Proof artifacts live in a named folder inside the checkout, `tmp/evidence/done-done-<YYYYMMDD-HHMMSS>/`, and must survive cleanup; a user-visible change adds the dark/light, phone/desktop and per-interaction motion passes of the review-evidence checklist below. This ignored folder keeps evidence outside the committed code branch. Per proof capture:

- The command lines run and their exit codes.
- The real output files the command produced: copy the rendered `out/<id>.mp4` into the evidence folder, plus a still extracted from it —
  `ffmpeg -y -ss <t> -i out/<id>.mp4 -frames:v 1 takeone-<feature>-<after>.png`
  (for a look/render change also extract the same timestamp from the pre-change render as `…-before.png`; stills are named `takeone-<feature>-<before|after>.png`).
- Machine-checkable output facts: `ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,codec_name -of json out/<id>.mp4 > probe.json`, and the sidecars (`camera.json`, `render.log`) that prove the pipeline ran.
- A manifest: `sha256sum * > SHA256SUMS` plus a line naming the producing commit (`git rev-parse HEAD`).

Standards: exercise the real user path (published CLI flags only — no internal setters, no test-only endpoints, no importing `dist/` internals as a library); capture the action and the resulting state, not just the final screen; verify side effects are files inside the take directory. `--no-jev` is a true offline mode (zero network calls); with a stored key `make` performs real paid calls — verification drives use `--no-jev` unless the point of the proof is the planner itself. A successful encode proves the pipeline and framing decisions ran; it does not qualify camera quality — visual quality claims need human review of the actual media. Label rendered defects `UNQUALIFIED`; missing prerequisites and incomplete validator/product proof must be reported as failure or inconclusive, never as release qualification.

## Review evidence

Every user-visible change ships proof for all four kinds below in the same run's
`tmp/evidence/done-done-<YYYYMMDD-HHMMSS>/` folder. takeone is a CLI with no
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
`midnight` (default), `aurora`, `mono`. Light themes: `paper`,
`sand`, `editorial` (`src/themes.ts`). One dark plus one light is the
floor; add another name from the relevant class when the change touches that token
(`display_font`, `bg_style`, `bg_pattern`, grain). `make --theme <name>` is the
one-drive equivalent. Copy the take per theme — `render` overwrites `out/<id>.mp4`
in place. For a motion change run `takeone motion ... --theme midnight` and
`--theme paper` as two fresh films; only the rerender of a saved motion take
rejects `--theme`/`--set` (`docs/verification/motion-films.md`).

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

### Visual defect pass

Every user-visible change runs this pass on the branch, with main's pass as the reference.
A defect fails the check: the pass exits 1, names the defect, its frame time and a crop.

```sh
TAKEONE_GATE=<memory gate, optional> scripts/verification/visual-pass.sh \
  tmp/evidence/visual-main --no-design                    # on main first: the reference (no design step: its stills have no reference film to take mocks from)
scripts/verification/visual-pass.sh tmp/evidence/visual-branch \
  --ref tmp/evidence/visual-main \
  --motion-ref <approved-motion-dark-contact.png> --motion-ref <approved-motion-light-contact.png>   # on the branch
scripts/verification/visual-controls.sh tmp/evidence/visual-main tmp/evidence/visual-controls
```

The pass always rebuilds `dist/` first: every render runs from
`dist/`, so a stale build renders old product code with new checker expectations and
stale sidecars fail good films (measured on main: a pre-112 cover-fit `camera.json`
against the contain-fit phone frame reads as status-bar and stage bands plus mismatch).
`visual-controls.sh` proves real defects still fail, including a blank strip drawn inside
the phone screen (`strip-in-phone`).
The pass ends with a required done-done design step (`scripts/verification/visual-design.sh`, run
automatically unless `--no-design`): it judges the held screen inside every cell still
with `done-done design`, one judge call per cell (a few screens each, not one call for the
whole pass, so a killed session loses at most one cell). Each `<cell>-t<time>.png` is
cropped to the shown rect its own check records
(`<cell>.json` facts.shown, `<cell>-t<time>-screen.png`), so the judge sees the screen
rather than the stage matte around it, and each screen goes next to the same moment from
the reference pass's film cropped the same way (`--mock <screen>=<cell>-t<time>-mock-screen.png`),
motion cells included. A still past the end of its reference film has no same moment and
is judged alone (logged) — an alone screen can fail on intended UI such as a dialog, so
the reference pass must render every cell film in full. The `--motion-ref` contacts stay side-sheet references only,
never design mocks: a live probe showed a motion still judged next to a contact sheet of
other content fails with a bogus `layout` defect (a future approved motion mock can use
`visual-design.sh --motion-mock`, first for motion-dark, second for motion-light).
A fail (exit 1) fails the pass; genuine unsure (exit 3) fails it too and names the screen for a
human look. An unsure whose reason shows the judge never answered (transport failure, not
a verdict) is retried up to 3 attempts per screen; a screen still unanswered after that fails
the run as JUDGE UNAVAILABLE (exit 4) with no design.json verdicts counted, so a dead judge
is never misreported as human-review unsure. Each cell's verdicts append to
`pass.log` and `design.log` as they land (`design.<cell>.json` keeps them; `--resume`
reuses those files after a kill), and the aggregate lands in `design.json` and `index.md`.

The design step installs the pinned done-done into a private prefix (never global installs or
repo dependencies) and judges on the approved live route `answerer:opencode`, model = the first
of `JUDGE_MODELS` that answers a probe, with author `JUDGE_AUTHOR` distinct from the judge agent.
Route, model and author are written to a scratch `DONE_DONE_HOME` inside the pass directory, so the
machine's global tooling and `~/.done-done` are untouched. No approved live model answering means
exit 4 JUDGE UNAVAILABLE with no verdicts counted: missing access is inconclusive, not PASS.

It renders 10 offline cells, each in midnight (dark) and paper (light): desktop 1920×1080
(`synth-take.ts`), phone 1080×1920 and 4:5 (`synth-portrait.ts`), large font
(`scripts/verification/synth-phone-font.ts`: the Android fixture's board at font_scale 1.3, the largest
common Android setting, 1080×1920), and `motion --device phone` of that board. It then checks
the settled holds (plus transition midpoints for strips) against each take's own source, mapped
by its sidecars (`camera.json`, `camera.cmd`, `stage.png`, beats/decisions, storyboard). Output is
flat: `<cell>.mp4`, stills, `<cell>-t<time>-side.png` (the still next to the reference at the same
moment, or the motion contact sheets), defect crops, `<cell>.json`, `pass.log`, `index.md`.
`--cells` picks cells; `--check-only` re-checks cells already rendered in `--work`. Edit-clock
takes (cuts, speed) are rejected, not checked. A real device run at the largest font is
`adb -s <emulator> shell settings put system font_scale 1.3` or
`xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large`, under the device
lock and memory gate, then `make --no-jev` and `visual-check.ts <take> --name <cell> --out <dir>`.

Limits (`LIMIT` in `scripts/verification/visual-check.ts`), measured on main 868ff39:

| check | limit | why |
|---|---|---|
| stretch | x/y scale differ > 1% | main's worst is 0.33%; a 4% ffmpeg stretch measures 4.0–4.6% (7.7% at one hold) |
| measurable axis | NCC drop ≥ 0.05 at a 3% scale error | text UIs drop 0.097–0.49; the testsrc2 bars in `synth-portrait.ts` drop ≤ 0.021, so that cell's stretch is reported unmeasured, and the font cell measures phone stretch |
| mismatch | robust NCC < 0.5 | main ≥ 0.988; a caption box over the UI stays ≥ 0.98; a cropped, rescaled film scores 0.02–0.37 |
| blank strip | ≥ 8 px (at 1080 short side) of flat band (luma sd ≤ 9) from a film or screen edge that differs by > 24 luma from the stage or screen expected there | main shows 0 px in every cell; the 32 and 48 px controls show 32 and 48. 8 px stays clear of anti-aliased card edges. A band within 24 luma of what it covers (black on midnight) is not seen |
| clipped text | ≥ 1 word or control cut (make's `edgeCuts`) at a film edge (on the film) or at a screen crop edge (on the source) | main's make cells cut nothing |
| off-screen | < 98% of the held element inside the visible window | main's worst is 100%; the slid-card control holds 32% |
| overlap | > 15% of the held element differs from its source | main's worst is 9.1% (the pointer resting on the field it just typed in); a caption box over the element is 92% |

Known on main 868ff39: `motion --device phone` cover-crops the phone hero, so both motion cells
fail clipped-text at the window's bottom edge (the Activity row's second line). That is a product
defect for its own task; it is not a reason to loosen the limit.

## Cleanup

The CLI leaves no processes running (each invocation is foreground and exits). Cleanup removes only what this run created:

```sh
rm -rf "$PWD/tmp/verify-takes" "$PWD/tmp/verify-state"   # scratch takes/state this run made (never anything under ~/Videos/takeone)
```

Never delete: `tmp/evidence/` (proof evidence survives cleanup — verify after cleanup with `ls tmp/evidence/done-done-*/`), committed evidence under `docs/evidence/` and `docs/quality-evidence/` (goldens), any take in the real takes root, or the portal token/state of a recording this run did not start. If this run started a recording it owns, end it with `takeone stop` before removing its scratch state dir.

## Keeping the map honest

Feature changes should update `docs/verification/` in the same change. Maintain these recipes and the done-done journeys together.
