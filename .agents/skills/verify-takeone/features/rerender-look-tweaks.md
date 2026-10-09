# Tweak the look and rerender (`render --theme` / `--set`)

README Quickstart 4: re-render an already-planned take with new look settings without planning again. `render` reads `screen.webm`, `take.json`, `analysis/beats.json` and `analysis/decisions.jsonl` from the take directory, resolves a fresh camera path from the `--set`/`--theme` overrides, and encodes a new MP4. It never calls the planner — rerendering is free, offline and deterministic given the same inputs.

## Sub-features

- Camera/theme overrides at render time: `--theme midnight|paper|aurora|mono|sand|editorial` and `--set key=value` for any token in `src/camera/defaults.ts` (colours like `background=#0B1220`, pacing like `idle_speed=3`, `quality=draft|standard|master`, `max_upscale`, fonts, grain, borders…).
- Saved theme precedence: a `"theme"` saved in `take.json` by `make --theme` applies on rerender; an explicit `--theme` flag wins; `--set` overrides both.
- Sidecar outputs: `camera.json`, `camera.cmd`, `render.log` (including libass font selection) and `motion-blur.json` when `motion_blur` sampling runs.
- Output aspect and format: `--aspect landscape|portrait|square|4:5` (1920×1080, 1080×1920, 1080×1080, 1080×1350; `16:9`/`9:16`/`1:1` are aliases), `--resolution 4k` (long edge 3840; `4:5` is 3072×3840), and `--format mp4|gif|webm|prores4444`. `--aspect`/`--resolution` re-solve the camera path so every shot re-frames around the action at the chosen ratio. When the output is narrower than the source (9:16/1:1/4:5 from 16:9) the camera crops in to fill — no letterboxed strip, the app fills the frame. GIF/WebM/ProRes transcode from the retained MP4 at the chosen dimensions. Explicit `--set out_w`/`out_h` are overridden by these presets. See `docs/edit-controls.md`.
- Saved `take.json` cuts: `"cuts":[{"t0":12,"t1":15}]` removes half-open source-second intervals within `trim_start`/`trim_end`. Footage, camera events, clicks and caption starts use the same output clock; surviving captions retain their reading duration. Overlapping, reversed or non-finite cuts and invalid trims reject before writing render artifacts. Manual zooms are not part of this cut/trim control.
- Saved `take.json` speed: timed regions `"speed":[{"t0":8,"t1":12,"rate":2}]` (rates `0.1..16`) and one untimed `"speed":[{"kind":"type_speed","rate":3}]` that speeds every typing burst detected from the take's own key events (`events.jsonl`, `k:"key"`, `cls:"char"`). Precedence is cuts, timed speed, typing speed, then idle speed; a timed region overrides a typing burst it overlaps. `type_speed` with no typing events has no effect and `render` says so once. Bad entries reject with their field and index (`speed[0].rate (0.1..16)`). See `docs/edit-controls.md`.

## How to get to it (user POV)

The user has a take that `make` already planned (feature 1 or 2) and wants a different look or pacing: `takeone render <take-dir> --theme paper --set idle_speed=3`. The command prints the MP4 path on stdout and rewrites `out/<id>.mp4` inside the take.

## Driving it with the takeone CLI

```sh
node bin/takeone.mjs render /abs/path/to/planned-take --theme paper --set idle_speed=3; echo "exit=$?"
# stdout: the path of the rendered MP4, e.g. /abs/path/to/planned-take/out/synth-demo.mp4
```

Proving end state: exit 0 and stdout ends in `out/<id>.mp4`; that file's mtime/hash changed vs the pre-existing render (capture a before/after still pair at the same timestamp — the theme change midnight→paper is clearly visible); `camera.json` reflects the override (e.g. non-default theme/background values); `render.log` lists the selected libass fonts. A before/after pair of stills named `takeone-rerender-before.png` / `takeone-rerender-after.png` is the standard evidence.

## Aspect/format proof on a saved demo take

```sh
node bin/takeone.mjs render <take> --aspect 9:16   # also landscape, 1:1, 4:5 (16:9/1:1 aliases)
node bin/takeone.mjs render <take> --format gif
node bin/takeone.mjs render <take> --format webm
node bin/takeone.mjs render <take> --resolution 4k
```

Proving end state, per aspect: exit 0; `ffprobe` width/height match the preset (landscape 1920×1080,
9:16 1080×1920, 1:1 1080×1080, 4:5 1080×1350; 4K long edge 3840, `4:5` 3072×3840). Sample frames
DURING camera moves (a `fps=1/2` contact sheet over the take) and confirm the action is in frame.
No letterboxing is machine-checkable: `ffmpeg -i out.mp4 -vf "cropdetect=limit=8:round=2:reset=0" -f null -`
must report the FULL frame on every frame (a hard black bar would shrink the crop). For `--format gif`,
`grep -aob NETSCAPE2.0 out.gif` then read `03 01 00 00` after it: loop count 0 = loops forever, and the
first/last frames must both be background (fade in/out) so the loop joins without a jump. WebM and the
4K MP4 must show `color_primaries=bt709 color_transfer=bt709 color_space=bt709` in `ffprobe -show_streams`.
The GIF can be large; transcode it from the retained MP4.

## Cut/trim proof on a saved demo take

Copy the planned demo take before editing. Render once without cuts, then add a cut spanning a known board action and caption start to `take.json` and rerender with the same CLI options. Keep both MP4s and stills. Confirm the removed board action is absent, the removed caption is absent from `captions.ass`, later clicks/captions move earlier by the removed duration, and ffprobe duration matches the retained footage. Rerender an unedited copy and compare `camera.json` byte-for-byte. Try a reversed cut and verify the CLI names `cuts[0]` and every input/output hash is unchanged. Also trim across an ongoing drag: its surviving subject and drag context must remain visible. A `rate: 1` timed speed region is inert; it must not change that trim result. Portrait dynamic quality requires the separately qualified padded-viewport predecessor; a static camera or zero motion samples is not qualification.

## Speed / typing speed-up proof on a saved demo take

Use a take that has real typing (`events.jsonl` `k:"key"`, `cls:"char"`; a `type` action
in `analysis/beats.json`). Copy it before editing. Render the copy once unchanged
(baseline) and once with one untimed `type_speed` entry added to `take.json`
(`"speed":[{"kind":"type_speed","rate":3}]`), same CLI options, one at a time through
the memory gate. Pass:

- `ffprobe` duration is shorter than baseline by the typing time saved,
  `sum(burst_len) * (1 - 1/rate)`, within 2 frames.
- A contact sheet sampled every 0.25s of output across each typing burst shows the
  text growing faster in the type_speed render with no dropped caption, click ring
  or camera jump at the burst edges. Detect the bursts from `events.jsonl` char
  key-downs grouped by the perception gap (1200ms); they match the `type` actions.
- Three non-typing landmarks map to the expected shifted output timestamps and
  decode to the same frame (SSIM ~1) as baseline.

Extreme case: add a timed region overlapping one typing burst
(`"speed":[{"kind":"type_speed","rate":3},{"t0":7,"t1":12,"rate":2}]`). The timed rate
wins in the overlap, so the overlapped burst plays at 2x, not 3x — the export is
longer there than the pure type_speed render.

## Gotchas

- `render` overwrites `out/<id>.mp4` in place — copy the take (or the old MP4) first when you need the before state.
- Motion takes (feature 5) reject `--theme`/`--set`: they rerender from their `storyboard.json` only; edit that file instead.
- `--set quality=master` encodes yuv444p and needs a High 4:4:4-capable player; `draft`/`standard` stay compatible yuv420p. Use standard defaults for evidence captures.
- Zoom never upscales past `max_upscale` (default 1.0); a rerender that "looks less zoomed" at higher output size is honoring that, not regressing.
- The encode is heavy ffmpeg work — hold the shared heavy lock in fleet contexts.
