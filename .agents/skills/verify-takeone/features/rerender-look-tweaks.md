# Tweak the look and rerender (`render --theme` / `--set`)

README Quickstart 4: re-render an already-planned take with new look settings without planning again. `render` reads `screen.webm`, `take.json`, `analysis/beats.json` and `analysis/decisions.jsonl` from the take directory, resolves a fresh camera path from the `--set`/`--theme` overrides, and encodes a new MP4. It never calls the planner — rerendering is free, offline and deterministic given the same inputs.

## Sub-features

- Camera/theme overrides at render time: `--theme midnight|paper|aurora|mono|neon|brutalist|sand|terminal|editorial` and `--set key=value` for any token in `src/camera/defaults.ts` (colours like `background=#0B1220`, pacing like `idle_speed=3`, `quality=draft|standard|master`, `max_upscale`, fonts, grain, borders…).
- Saved theme precedence: a `"theme"` saved in `take.json` by `make --theme` applies on rerender; an explicit `--theme` flag wins; `--set` overrides both.
- Sidecar outputs: `camera.json`, `camera.cmd`, `render.log` (including libass font selection) and `motion-blur.json` when `motion_blur` sampling runs.
- Saved `take.json` cuts: `"cuts":[{"t0":12,"t1":15}]` removes half-open source-second intervals within `trim_start`/`trim_end`. Footage, camera events, clicks and caption starts use the same output clock; surviving captions retain their reading duration. Overlapping, reversed or non-finite cuts and invalid trims reject before writing render artifacts. Speed regions and manual zooms are not part of this cut/trim control.

## How to get to it (user POV)

The user has a take that `make` already planned (feature 1 or 2) and wants a different look or pacing: `takeone render <take-dir> --theme paper --set idle_speed=3`. The command prints the MP4 path on stdout and rewrites `out/<id>.mp4` inside the take.

## Driving it with the takeone CLI

```sh
node bin/takeone.mjs render /abs/path/to/planned-take --theme paper --set idle_speed=3; echo "exit=$?"
# stdout: the path of the rendered MP4, e.g. /abs/path/to/planned-take/out/synth-demo.mp4
```

Proving end state: exit 0 and stdout ends in `out/<id>.mp4`; that file's mtime/hash changed vs the pre-existing render (capture a before/after still pair at the same timestamp — the theme change midnight→paper is clearly visible); `camera.json` reflects the override (e.g. non-default theme/background values); `render.log` lists the selected libass fonts. A before/after pair of stills named `takeone-rerender-before.png` / `takeone-rerender-after.png` is the standard evidence.

## Cut/trim proof on a saved demo take

Copy the planned demo take before editing. Render once without cuts, then add a cut spanning a known board action and caption start to `take.json` and rerender with the same CLI options. Keep both MP4s and stills. Confirm the removed board action is absent, the removed caption is absent from `captions.ass`, later clicks/captions move earlier by the removed duration, and ffprobe duration matches the retained footage. Rerender an unedited copy and compare `camera.json` byte-for-byte. Try a reversed cut and verify the CLI names `cuts[0]` and every input/output hash is unchanged. Also trim across an ongoing drag: its surviving subject and drag context must remain visible. An identity-speed declaration is inert until speed support lands; it must not change that trim result. Portrait dynamic quality requires the separately qualified padded-viewport predecessor; a static camera or zero motion samples is not qualification.

## Gotchas

- `render` overwrites `out/<id>.mp4` in place — copy the take (or the old MP4) first when you need the before state.
- Motion takes (feature 5) reject `--theme`/`--set`: they rerender from their `storyboard.json` only; edit that file instead.
- `--set quality=master` encodes yuv444p and needs a High 4:4:4-capable player; `draft`/`standard` stay compatible yuv420p. Use standard defaults for evidence captures.
- Zoom never upscales past `max_upscale` (default 1.0); a rerender that "looks less zoomed" at higher output size is honoring that, not regressing.
- The encode is heavy ffmpeg work — hold the shared heavy lock in fleet contexts.
