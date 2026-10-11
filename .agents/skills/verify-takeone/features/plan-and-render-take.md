# Plan and render a recorded take (`make`)

The core pipeline: `takeone make <id>` segments an existing take into beats, finds changed regions, decides each beat's shot (locally, or via Jev when a key is stored), and renders the framed MP4. `<id>` is a take directory name under the takes root or an absolute take path.

## Sub-features

- Beat segmentation and change-region analysis (`analysis/regions.json`, `analysis/beats.json`, `analysis/actions.json`, one decision per line in `analysis/decisions.jsonl`).
- Local vs Jev planning: `--no-jev` keeps every decision local (zero network); with a stored key, Jev decides judgement beats inside a hard token preflight (`--max-tokens`, default 40k per take minute). Jev responses cache to `analysis/jev-cache.jsonl` — replanning an unchanged take costs nothing.
- `--about "<topic>"` adds a key-moment question; `--screen-text` opts in to redacted OCR (needs `tesseract`).
- Theme selection (`--theme NAME`) and camera-setting overrides (`--set key=value`) at plan time.
- Cost accounting: usage lands in `take.json` (`jev.input_tokens`, `jev.usd`).
- Wide action camera pushes and explicit `take.json.zooms` holds: local subjects stay whole, unrelated panels do not widen the shot, and manual holds direct both solver and hold-style paths on the edited video clock. Portrait/square camera motion is intentionally OFF (including held/manual paths); those exports keep the existing centred rest framing and stage geometry, not a qualified portrait push-in.

## How to get to it (user POV)

After recording a take (feature 4) or creating one synthetically (feature 1), the user runs `takeone make <id>` — with `--about` for better key moments when Jev is enabled. The MP4 lands at `<take>/out/<id>.mp4` with the plan beside it in `analysis/`.

## Driving it with the takeone CLI

Offline verification drive (no key, no network, no capture):

```sh
node bin/takeone.mjs make /abs/path/to/take --no-jev --about "Creating a task and moving it across a board"; echo "exit=$?"
```

Proving end state: exit 0; `analysis/decisions.jsonl` has one line per decided beat; `out/<id>.mp4` exists and `ffprobe` reports the expected dimensions (default 1920×1080; 1080×1920 for portrait takes without `out_w`/`out_h` overrides); `take.json` carries updated usage/render metadata. For a Jev-enabled drive, additionally check `analysis/jev-cache.jsonl` exists and `take.json`'s `jev.input_tokens` is within the preflight cap — and treat it as a paid run: verification defaults to `--no-jev`.

Error shapes worth asserting: `takeone make: no take at <dir> (take.json missing)` exits 2; `PreflightRefusal` exits 2 with a message naming the token cap.

## verify-takeone: 4K action and manual camera proof

Use `node scripts/headless-scene.mjs /abs/evidence/board-before --cursor=hidden`
for a fresh 3840×2160 Tidewater take. Run `node bin/takeone.mjs make
/abs/evidence/board-before --no-jev` on the baseline; preserve its MP4 and
`camera.json`. Copy the same inputs to `board-after` and repeat on the candidate.
Use task-owned HOME/XDG/state/takes roots; run capture, renders and ffmpeg through
the assigned memory gate with bounded encoder/filter threads.

For each beat, map its times through the same idle/edit clock as the render and
record `z = max(width, height * out_w / out_h) / cameraFrame.w`. The first dialog
must rise above 1× (the default 4K→1080p ceiling is 2×). A 1920×1080 synthetic take
at default 1920×1080 output correctly stays at 1×: do not lift `max_upscale` to
make that control pass.

Also copy the planned take, add `zooms: [{t0:3.4,t1:13.3,
bbox:[1344,504,1152,940],level:3}]` to `take.json`, and drive `render` with default
settings and `--set camera_path=hold`. Compare the emitted camera hold to the
requested whole dialog; test a cut/speed-edited span on the same source clock.
Render an untitled copy, a `--theme paper` copy, and a portrait re-frame
(`--set out_w=1080 --set out_h=1920`); portrait is not a responsive phone UI.

Keep `takeone-zoom-before.mp4` and `takeone-zoom-after.mp4`, and extract
`takeone-zoom-<before|after>-{start,mid,settled,dialog-start,dialog-mid,dropdown}.png`
at observed motion readiness, not guessed wall-clock offsets. On the fixed
Tidewater take these are 2.3, 2.866667, 3.4, 2.75, 3.2 and 11.7 seconds of the
emitted video; recheck `camera.json` when timing changes. The 2.75 s frame is
pre-paint camera approach, not painted-dialog containment; the dialog is visible
at 3.2 s. For portrait, retain a matched pre-fix/candidate 1080×1920 make with
identical input hashes and settings. Its `camera.json` must stay at the centred
rest frame for the entire film; rerender with manual zooms and `camera_path=hold`
to verify they cannot re-enable motion (manual requests print a scope warning).
Inspect 3.2/3.4/4.5 s and pre-close frames plus a contact sheet; compare the visible
source viewport to the pre-fix rest framing. Existing crop-to-fill/stage geometry
must not be redesigned to pass. Measure the actual painted border from source
pixels: a perception bbox can include non-border padding and is not a pixel verdict.
Decode every native wide AND portrait frame in every painted dialog interval
through its close, including repeated arrivals and pre-close motion. On the
retained Tidewater capture both 3.2..13.583 s AND 35.033..37.85 s are painted;
re-detect these intervals from source pixels for a fresh capture. Record each
frame's visible border loss, keep the worst decoded baseline/candidate frames,
and fail on any loss; sampled first-arrival frames or raw-rectangle containment
alone cannot establish this bar. Portrait-motion-OFF acceptance is not portrait
push-in PASS; that remains a separate mission.
Do not substitute letterboxing or lift the native-pixel ceiling. Add a contact sheet
with `fps=1/3,scale=480:-1,tile=4x4` and ffprobe JSON. Look at every frame:
the first dialog must be whole during its arrival, not only after settling;
its text and dropdown must be readable. Include the full painted popup border
beyond the modal, at dropdown arrival (11.2 s on the fixed take) as well as settled
11.7 s; an in-form popup belongs to the typed form's footprint even when far below
the caret. Keep the clipped retained 11.2 s film as a negative control for the audit;
process exit zero is not a film PASS, and unresolved source-presence/localization
frames are inconclusive, never zero loss. Run the same source-eligible-frame audit
on the manual/edit-clock film using its actual cut/speed mapping.
Cropping the unrelated background is not
a guarantee that every off-subject label stays whole. Retain the same probes for
manual/hold/untitled variants. The runnable real-CLI regression is
`node --test --test-name-pattern='render without trim_end' test/camera.test.ts`.

## Gotchas

- `make` without `--no-jev` and with a stored key performs real paid API calls; a token preflight refuses the run before any call if the plan would exceed the cap, but the verification default is `--no-jev`.
- Beats are capped at 30 per minute; idle gaps may merge — a shorter-than-raw output duration is expected, not a bug.
- A trim must overlap the video; only the overlap is planned.
- Recording-quality claims need human review of the rendered media; a passing encode does not qualify camera quality.
