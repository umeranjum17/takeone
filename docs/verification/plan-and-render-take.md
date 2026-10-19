# Plan and render a recorded take (`make`)

The core pipeline: `takeone make <id>` segments an existing take into beats, finds changed regions, decides each beat's shot (locally, or via the AI planner for judgement beats when a credential is set), and renders the framed MP4. `<id>` is a take directory name under the takes root or an absolute take path.

## Sub-features

- Beat segmentation and change-region analysis (`analysis/regions.json`, `analysis/beats.json`, `analysis/actions.json`, one decision per line in `analysis/decisions.jsonl`).
- Per-beat camera choices in `analysis/plan.json`: `shot` (give the beat a camera move), `idle` (pull back in a long pause), `follow` (track the pointer). Each has `by`: `ai` (the planner answered), `rule` (no answer, the rules decide) or `user`. Edit a `value` and set its `by` to `user`, then run `takeone render <id>`: the render applies it, and a rerun of `make` keeps it. Only `by: user` entries are applied; an edit that leaves `by` as `ai` is ignored and overwritten by the next `make`. `shot=true` applies only where a camera move is possible: scroll, idle, pointer-only travel and redundant wide cuts keep no shot. `idle` and `follow` are read only on idle beats and on drag or travel beats: a user value for them on other beat kinds changes nothing in the render. plan.json edits do not reach the Android tap fallback, which builds its own beats. Proof (fixture, non-live): `test/make.test.ts` "per-beat camera answers" checks that the planner's answers reach `plan.json`, that the user's edit changes `camera.json`, and that a rerun of `make` keeps it; "a user shot=false in plan.json removes the camera zoom" checks that a user `shot=false` beats the planner's shot in the render. A real recording with a planner call is not proven for these answers.
- Local vs AI planning: `--no-ai` keeps every decision local (zero network); with a stored credential or explicitly picked plan account, the planner decides judgement beats inside a hard token preflight (`--max-tokens`, default 40k per take minute). The `make` log prints `preflight: N beats, K calls (film included), X planned tokens` and, at the end, `planner: R requests (C from cache), T request tokens; ... calls a minute, ... request tokens a minute` (also in `take.json` `planner.calls_per_min` / `planner.request_tokens_per_min`). Planner answers cache to `analysis/planner-cache.jsonl` — replanning an unchanged take costs nothing; `--replan` asks again.
- Picked-account planning: `planner.json` can explicitly select the installed Claude or Codex CLI account, the installed `pi` CLI (`{"backend":"pi","bin":"<absolute pi>","model":"<model>"}`), or a BYOKit ChatGPT handle, and an explicit choice always wins. With no saved choice, `make` offers an already-signed-in Claude or Codex CLI account first, then a stored key, then local rules. A model the person's own pi is signed in for plans the take with no key of TakeOne's own; see [Live planner run on the installed pi](#live-planner-run-on-the-installed-pi).
- `--goal "<sentence>"` sharpens key moments (always asked); `--style "<word>"` steers the film; screen words are read by default with a planner (`--no-screen-text` opts out; needs `tesseract`).
- Theme selection (`--theme NAME`) and camera-setting overrides (`--set key=value`) at plan time.
- Cost accounting: usage lands in `take.json` (`planner.mode`, `planner.backend`, `planner.model`, `planner.input_tokens`, `planner.usd`); see the [per-provider table](../cost.md#per-provider-cost-slice-1).
- Wide action camera pushes and explicit `take.json.zooms` holds: local subjects stay whole, unrelated panels do not widen the shot, and manual holds direct both solver and hold-style paths on the edited video clock. Portrait crop-to-fill exports (a portrait cut from a wider screen) move too: the solver plans on the fill window the export renders, keeps a dialog framed until it closes, and arrives spring-settled, so a dialog the window can hold stays whole through every transition, including a later dialog whose planned subject (such as the full-width bar that opened it) the window can never hold; since the fill window cannot widen around a drag, it centres on the grab and pans in lockstep with the dragged pointer, so the lifted surface stays where it was picked up, then holds the drop like any arrival; auto and manual zooms apply, the hold path stays wide-only. Portrait here means taller than wide (9:16 and 4:5). Square exports and phone takes keep the centred rest framing (a manual zoom prints a scope warning).

## How to get to it (user POV)

After recording a take (feature 4) or creating one synthetically (feature 1), the user runs `takeone make <id>` — with `--goal` for sharper key moments when the planner is enabled. The MP4 lands at `<take>/out/<id>.mp4` with the plan beside it in `analysis/`.

## Driving it with the takeone CLI

Offline verification drive (no key, no network, no capture):

```sh
node bin/takeone.mjs make /abs/path/to/take --no-ai --goal "Creating a task and moving it across a board"; echo "exit=$?"
```

Proving end state: exit 0; `analysis/decisions.jsonl` has one line per decided beat; `analysis/plan.json` has one entry per beat; `out/<id>.mp4` exists and `ffprobe` reports the expected dimensions (default 1920×1080; 1080×1920 for portrait takes without `out_w`/`out_h` overrides); `take.json` carries updated usage/render metadata. For a planner-enabled drive, additionally check `analysis/planner-cache.jsonl` exists and `take.json`'s `planner.input_tokens` is within the preflight cap — and treat it as a billed run: verification defaults to `--no-ai`. A provider that cannot serve the run stops before rendering with exit 3 and the three choices.

Error shapes worth asserting: `takeone make: no take at <dir> (take.json missing)` exits 2; `PreflightRefusal` exits 2 with a message naming the token cap.

## Live planner run on the installed pi

Write `${XDG_CONFIG_HOME:-$HOME/.config}/takeone/planner.json` with `{"backend":"pi","bin":"/absolute/path/to/pi","model":"deepseek/deepseek-flash"}`. `bin` is the person's own installed pi and `model` any model that pi can reach; BYOKit runs it once per planner call in JSON mode with no tools, extensions, skills, prompt templates, context files or session, and never reads or copies pi's key or settings. TakeOne probes readiness first with `pi auth check --model <model> --json` (`status: "ready"`): `takeone doctor | grep ai-planner` prints `AI planner: pi (<model>)` when it passes, and `make` stops with exit 3 and that check when it does not — a missing binary or an unsigned model never falls back to rules.

Drive it on a real take with the person's normal `HOME` and their already signed-in pi, no `--no-ai`:

```sh
node bin/takeone.mjs doctor | grep ai-planner
node bin/takeone.mjs make <take-dir> --set out_w=3840 --set out_h=2160; echo "exit=$?"
```

Proving end state: exit 0; `take.json` with `planner.mode: "ai"`, `planner.backend: "pi"`, `planner.model` as configured, `input_tokens`/`output_tokens` reported by pi and `planner.usd: null`; `analysis/decisions.jsonl` with `decided_by: "ai"` for the beats that were asked; `out/<id>.mp4` rendered. Keep the make log, the MP4 and a contact sheet. The failure path is worth asserting too: point `bin` at a path with no pi and `make` must exit 3 naming the missing binary and the check to run, not render a fallback film.

Cost limit: pi reports tokens but no price, so a cost per output minute cannot be computed from this route; record tokens and say the price is unknown rather than inferring one.

## Live planner run on a picked account

For the installed Codex subscription, write `${XDG_CONFIG_HOME:-$HOME/.config}/takeone/planner.json` with `{"backend":"codex","auth":"account","account":"installed-codex","bin":"/absolute/path/to/codex","model":"gpt-6-luna"}` (`backend` `claude-code` with `"account":"installed-claude"` selects the installed Claude CLI the same way). Set `bin` to the already installed executable; BYOKit checks its existing sign-in and never reads, copies or changes login files. This selection is explicit and wins over discovery; with no saved `planner.json`, `make` offers an already-signed-in Claude or Codex CLI account first, so no key is needed.

The board authorization for this live proof is limited to small runs and at most two attempts per take, through 21 Oct 11:50Z. These are limits on this proof authorization, not product-wide enforcement; a user-invoked live `make` may incur charges. Retain the token preflight: it refuses runs exceeding the configured cap before any planner call.

Run `node bin/takeone.mjs make <take-dir>` with normal `HOME` and no `--no-ai`. A successful live proof requires exit 0, `take.json` with `planner.mode: "ai"`, the selected model, reported token counts and `planner.usd` (null means cost unknown), plus `analysis/decisions.jsonl` with `decided_by: "ai"` for every planned beat. Keep the make log, rendered MP4 and a contact sheet; derive tokens and known cost per output-video minute from `take.json` totals and the MP4 duration reported by `ffprobe`. Do not treat planned calls as completed calls or infer a price when `planner.usd` is null.

## done-done: 4K action and manual camera proof

Use `node scripts/headless-scene.mjs /abs/evidence/board-before --cursor=hidden`
for a fresh 3840×2160 Tidewater take. Run `node bin/takeone.mjs make
/abs/evidence/board-before --no-ai` on the baseline; preserve its MP4 and
`camera.json`. Copy the same inputs to `board-after` and repeat on the candidate.
Use task-owned HOME/XDG/state/takes roots; run capture, renders and ffmpeg through
the assigned memory gate with bounded encoder/filter threads.

For each beat, map its times through the same idle/edit clock as the render and
record `z = max(width, height * out_w / out_h) / cameraFrame.w`. The first dialog
must rise above 1× (the default 4K→1080p ceiling is 2×). With a stored planner credential,
repeat `make` without `--no-ai` on a third copy (a billed run: record `take.json`
`planner.input_tokens`/`planner.usd` per output minute): the AI plan must also push in on
the first dialog while its title is typed, and its max zoom and frames above 1.05×
must not fall below the `--no-ai` film's (on the fixed take: 2× and 656 vs 622
frames, from 1.097× and 77 before the median-tightness fix). `analysis/planner-cache.jsonl`
holds the raw tightness answer per beat when a level looks wrong. A 1920×1080 synthetic take
at default 1920×1080 output correctly stays at 1×: do not lift `max_upscale` to
make that control pass.

Also copy the planned take, add `zooms: [{t0:3.4,t1:13.3,
bbox:[1344,504,1152,940],level:3}]` to `take.json`, and drive `render` with default
settings and `--set camera_path=hold`. Compare the emitted camera hold to the
requested whole dialog; test a cut/speed-edited span on the same source clock.
A manual hold arrives on painted content: when a cut or result paints its box
during the approach, the camera stays still until it settles, then pushes in
(on the fixed take: still at 1.29× until the 3.2 s paint, not 1.99× before it).
A popup that `analysis/regions.json` sees paint partly inside the box widens the
hold to keep it whole from that frame (the Priority menu at 11.2 s, 1.75×), when
the export's window can hold both. The pull-out from ~11.0 s on that take is
drag visibility for the 13.6 s drag, not the popup. A take without `zooms` must
keep a byte-identical `camera.json` (wide and 4:5, `--no-ai` and AI plans).
Render an untitled copy, a `--theme paper` copy, and a portrait re-frame
(`--set out_w=1080 --set out_h=1920`); portrait is not a responsive phone UI.

Keep `takeone-zoom-before.mp4` and `takeone-zoom-after.mp4`, and extract
`takeone-zoom-<before|after>-{start,mid,settled,dialog-start,dialog-mid,dropdown}.png`
at observed motion readiness, not guessed wall-clock offsets. On the fixed
Tidewater take these are 2.3, 2.866667, 3.4, 2.75, 3.2 and 11.7 seconds of the
emitted video; recheck `camera.json` when timing changes. The 2.75 s frame is
pre-paint camera approach, not painted-dialog containment; the dialog is visible
at 3.2 s. For portrait, retain a matched pre-fix/candidate 1080×1920 make with
identical input hashes and settings, and a wide make whose `camera.json` must be
byte-identical before and after (portrait changes are crop-to-fill only). Rerender
portrait with manual zooms (one on the dialog, one on an off-centre panel). The
visible source window is `sourceViewport` (≤ 1149.75 px wide at 1080×1920 from
4K; the 1140 px modal has ±4.875 px of slack), so the camera's centre is the verdict.
Existing crop-to-fill/stage geometry must not be redesigned to pass. Measure the
actual painted border from source pixels: a perception bbox can include non-border
padding and is not a pixel verdict.
Decode every native wide AND portrait frame in every painted dialog interval
through its close, including repeated arrivals and pre-close motion. On the
retained Tidewater capture both 3.2..13.583 s AND 35.033..37.85 s are painted;
re-detect these intervals from source pixels for a fresh capture. Record each
frame's visible border loss, keep the worst decoded baseline/candidate frames,
and fail on any loss or unresolved inconclusive frame; sampled first-arrival frames
or raw-rectangle containment alone cannot establish this bar.
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
For the portrait drag, keep frames across the grab and drop (16.65..18.583 s on the
fixed take, its only drag): the dragged card (source x 500..1240 at the grab)
stays whole as the crop pans with the pointer, and the drop column (`In progress`,
source x 1328..2068) stays whole from release through `min_shot`.
Cropping the unrelated background is not
a guarantee that every off-subject label stays whole. Retain the same probes for
manual/hold/untitled variants. The runnable real-CLI regression is
`node --test --test-name-pattern='render without trim_end' test/camera.test.ts`.

## Gotchas

- `make` without `--no-ai` and with a stored credential performs real planner calls; a token preflight refuses the run before any call if the plan would exceed the cap, but the verification default is `--no-ai`.
- Beats are capped at 30 per minute; idle gaps may merge — a shorter-than-raw output duration is expected, not a bug.
- A trim must overlap the video; only the overlap is planned.
- Recording-quality claims need human review of the rendered media; a passing encode does not qualify camera quality.
